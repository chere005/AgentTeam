import { createServer } from "node:net";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

const freePort = async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
};

test("preview isolation: no IPC bridge or credentials, restricted navigation, console capture, viewports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-preview-"));
  const project = join(directory, "project");
  await mkdir(project);
  const other = await freePort();
  // Dev server fixture: reports what the embedded page can see, records request headers.
  await writeFile(
    join(project, "dev.cjs"),
    `const http=require('node:http'),fs=require('node:fs');
const log=(n,v)=>fs.writeFileSync(n,JSON.stringify(v));
fs.writeFileSync('env.json',JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith('AGENTTEAM_'))));
const seen=[];
http.createServer((req,res)=>{
  seen.push({url:req.url,authorization:req.headers.authorization??null,cookie:req.headers.cookie??null,origin:req.headers.origin??null});
  log('requests.json',seen);
  if(req.method==='POST'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{fs.writeFileSync('report.json',b);res.end('ok')});return}
  res.setHeader('content-type','text/html');
  res.end('<h1>Isolated preview</h1><script>'+
   'let parentAccess="blocked";try{parentAccess=String(typeof parent.document.body)}catch(e){}'+
   'let top2="blocked";try{top2=String(typeof top.agentteam)}catch(e){}'+
   'console.error("preview-console-test boom");'+
   'fetch("/report",{method:"POST",body:JSON.stringify({agentteam:typeof window.agentteam,ipc:typeof window.ipcRenderer,require:typeof require,process:typeof process,parentAccess,topAgentteam:top2,ls:Object.keys(localStorage).length,origin:location.origin})});'+
   'setTimeout(()=>{location.href="http://127.0.0.1:${other}/"},600);'+
  '</script>');
}).listen(Number(process.env.PORT),'127.0.0.1');`,
  );
  // A second local server the preview must NOT be able to navigate to.
  await writeFile(
    join(project, "other.cjs"),
    `require('node:http').createServer((q,r)=>{require('node:fs').writeFileSync('other-hit','1');r.end('<h1>escaped</h1>')}).listen(${other},'127.0.0.1');`,
  );
  const port = await freePort();
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      // Canary: AgentTeam-prefixed variables must not reach the dev server.
      AGENTTEAM_API_TOKEN: "canary-should-not-leak",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.evaluate(async (folder) => {
      const snapshot = await window.agentteam.request("GET", "/snapshot");
      const { id, createdAt, control, ...config } = snapshot.agents[0];
      await window.agentteam.request("PUT", "/agents/" + id, {
        ...config,
        workspaces: [{ path: folder, access: "write", active: true }],
      });
    }, project);
    await openFeature(page, "Preview");
    await page
      .getByLabel("Server command")
      .fill(`"${process.execPath}" dev.cjs`);
    await page.getByLabel("Preview URL").fill(`http://127.0.0.1:${port}`);
    // The unrelated second server is started by the test, not by AgentTeam.
    const { spawn } = await import("node:child_process");
    const side = spawn(process.execPath, ["other.cjs"], {
      cwd: project,
      stdio: "ignore",
    });
    try {
      await page
        .getByRole("button", { name: "Start server", exact: true })
        .click();
      await expect(page.getByText(/Server: Ready/)).toBeVisible();
      await page.getByRole("button", { name: "Open / reload preview" }).click();
      const frame = page.frameLocator(
        "iframe[title='Local development preview']",
      );
      await expect(
        frame.getByRole("heading", { name: "Isolated preview" }),
      ).toBeVisible();
      await expect
        .poll(async () =>
          readFile(join(project, "report.json"), "utf8").catch(() => ""),
        )
        .not.toBe("");
      const report = JSON.parse(
        await readFile(join(project, "report.json"), "utf8"),
      );
      expect(report).toMatchObject({
        agentteam: "undefined",
        ipc: "undefined",
        require: "undefined",
        process: "undefined",
        parentAccess: "blocked",
        topAgentteam: "blocked",
        ls: 0,
        origin: `http://127.0.0.1:${port}`,
      });
      // No credentials reached the server process or its requests.
      expect(
        JSON.parse(await readFile(join(project, "env.json"), "utf8")),
      ).toEqual([]);
      const requests = JSON.parse(
        await readFile(join(project, "requests.json"), "utf8"),
      );
      for (const r of requests) {
        expect(r.authorization).toBeNull();
        expect(r.cookie).toBeNull();
      }
      // Navigation away from the configured origin is blocked.
      await page.waitForTimeout(1500);
      await expect(
        frame.getByRole("heading", { name: "Isolated preview" }),
      ).toBeVisible();
      await expect(readFile(join(project, "other-hit"))).rejects.toThrow();
      // Console errors from the embedded page are captured.
      await expect(page.getByText("preview-console-test boom")).toBeVisible();
      // Viewport presets resize the frame; Open in browser is offered.
      await page.getByRole("button", { name: /Mobile 375/ }).click();
      await expect
        .poll(
          async () =>
            (await page.locator("iframe.development-frame").boundingBox())
              ?.width,
        )
        .toBe(375);
      await expect(
        page.getByRole("link", { name: "Open in browser" }),
      ).toHaveAttribute("href", new RegExp(`^http://127.0.0.1:${port}`));
      await page
        .getByRole("button", { name: "Stop server", exact: true })
        .click();
      await expect(page.getByText(/Server: Stopped/)).toBeVisible();
    } finally {
      side.kill();
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
