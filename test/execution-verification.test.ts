import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { independentPi } from "../src/execution-verification.ts";
import {
  runVerificationCommand,
  verificationExecutable,
  verificationRuntimeRoots,
} from "../src/verification-confinement.ts";

async function fixture(t: { after(fn: () => unknown): void }) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-verification-")),
  );
  const workspace = join(base, "workspace");
  const profile = join(base, "Profile");
  await mkdir(workspace);
  await mkdir(profile);
  const store = new Store(join(profile, "agentteam.sqlite"));
  const service = new TeamService(store, new SkillCatalog([]));
  const agent = await service.saveAgent({
    name: "Writer",
    environment: "claude",
    tools: ["read", "write", "edit", "shell"],
    workspaces: [{ path: workspace, access: "write", active: true }],
  });
  const workflow = service.workflow({
    name: "Verification fixture",
    goal: "Inspect a controlled fixture",
    ownerId: agent.id,
    completionCriteria: "Verified",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Inspect a controlled fixture",
    completionCriteria: "Observed evidence",
    resourcePaths: [workspace],
  });
  t.after(async () => {
    store.close();
    await writableDirectories(base);
    await rm(base, { recursive: true, force: true });
  });
  return { base, workspace, profile, store, service, task };
}
async function writableDirectories(directory: string) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      await writableDirectories(join(directory, entry.name));
}
const supported = process.platform === "darwin" || process.platform === "linux";
const canConfine = async () => {
  if (!supported) return false;
  if (process.platform === "linux")
    try {
      await verificationExecutable(["bwrap"]);
    } catch {
      return false;
    }
  return true;
};

test("independent references agree at both precision conventions and are immutable", async (t) => {
  const f = await fixture(t);
  const significant = f.service.verification.ensurePiReference(
    500,
    "significant",
  );
  assert.equal(significant.stdout.length, 501);
  assert.equal(significant.stdout.slice(-20), "48912279381830119491");
  const decimal = f.service.verification.ensurePiReference(500, "decimal");
  assert.equal(decimal.stdout.length, 502);
  assert.equal(decimal.stdout.slice(-10), "8301194912");
  assert.equal(decimal.stdout.slice(0, -1), significant.stdout);
  assert.equal(independentPi(1, "significant"), "3");
  assert.equal(independentPi(2, "decimal"), "3.14");
  assert.equal(
    f.service.verification.ensurePiReference(500, "significant").id,
    significant.id,
  );
  assert.throws(
    () =>
      f.store.put("verification-reference", {
        ...significant,
        stdout: "wrong",
      }),
    /immutable/,
  );
});

test("Python execution records actual immutable source and rejects stale evidence, wrong output, external imports and fabricated prose", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  const source = join(f.workspace, "hello.py");
  await writeFile(source, "print('Hello, world!')\n");
  const reference = f.service.verification.registerReference({
    label: "User literal",
    stdout: "Hello, world!",
  });
  const spec = {
    entry: "hello.py",
    language: "python" as const,
    referenceId: reference.id,
  };
  const first = await f.service.verification.verify(f.task.id, spec);
  assert.equal(first.passed, true, JSON.stringify(first));
  assert.equal(first.stdout, "Hello, world!\n");
  assert.ok(first.commands.every((c) => c.sandbox));
  assert.equal(first.sourceFiles.length, 1);
  assert.ok(first.snapshotHash.length === 64);
  assert.equal(
    await readFile(join(first.snapshotDirectory, "Source", "hello.py"), "utf8"),
    "print('Hello, world!')\n",
  );
  const check = { ...first.spec, type: "execution-verified" as const };
  assert.equal(
    (await f.service.verification.require(f.task, check)).id,
    first.id,
  );
  assert.equal(
    f.service.verification.requireCurrent(f.task, check).id,
    first.id,
  );
  assert.equal(
    (await f.service.verification.verify(f.task.id, spec)).id,
    first.id,
  );
  assert.throws(
    () => f.store.put("execution-verification", { ...first, passed: false }),
    /immutable/,
  );
  const snapshotSource = join(first.snapshotDirectory, "Source", "hello.py");
  await chmod(snapshotSource, 0o600);
  await writeFile(snapshotSource, "print('tampered')\n");
  await assert.rejects(
    f.service.verification.require(f.task, check),
    /stored immutable snapshot/,
  );
  assert.throws(
    () => f.service.verification.requireCurrent(f.task, check),
    /stored immutable snapshot/,
  );
  await writeFile(source, "print('Hello, world!!')\n");
  assert.throws(
    () => f.service.verification.requireCurrent(f.task, check),
    /Source changed/,
  );
  await assert.rejects(
    f.service.verification.require(f.task, check),
    /No successful/,
  );
  const wrong = await f.service.verification.verify(f.task.id, spec);
  assert.equal(wrong.passed, false);
  assert.match(wrong.reason, /Entire program output/);
  await writeFile(
    source,
    "print('I ran it, exit status: 0, stdout: Hello, world!')\n",
  );
  assert.equal(
    (await f.service.verification.verify(f.task.id, spec)).passed,
    false,
  );
  await writeFile(source, "import requests\nprint('Hello, world!')\n");
  const imported = await f.service.verification.verify(f.task.id, spec);
  assert.equal(imported.passed, false);
  assert.match(imported.stderr, /External import is forbidden/);
  assert.equal(f.store.list("lease").length, 0);
  assert.equal(f.store.list("slot").length, 0);
});

test("sandbox permits source reads/output writes but denies outside access and confines generated descendants", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  const outside = join(f.base, "outside.txt");
  const forbidden = join(f.base, "forbidden-write.txt");
  await writeFile(outside, "PRIVATE CANARY");
  const server = createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const program = `import os,socket\nresults=[]\nfor path,mode in [( ${JSON.stringify(outside)},'r'),(${JSON.stringify(forbidden)},'w')]:\n try:\n  open(path,mode);results.append('ALLOWED')\n except OSError: results.append('blocked')\ntry:\n socket.create_connection(('127.0.0.1',${address.port}),0.3);results.append('ALLOWED')\nexcept OSError: results.append('blocked')\n${process.platform === "darwin" ? "try:\n p=os.fork()\n if p==0: os._exit(0)\n os.waitpid(p,0);results.append('ALLOWED')\nexcept OSError: results.append('blocked')\n" : `p=os.fork()\nif p==0:\n try:\n  open(${JSON.stringify(forbidden)},'w');os._exit(1)\n except OSError: os._exit(0)\n_,status=os.waitpid(p,0)\nresults.append('blocked' if os.waitstatus_to_exitcode(status)==0 else 'ALLOWED')\n`}open('allowed.txt','w').write('ok')\nprint(','.join(results))\n`;
  await writeFile(join(f.workspace, "contain.py"), program);
  const reference = f.service.verification.registerReference({
    label: "Containment probe",
    stdout: "blocked,blocked,blocked,blocked",
  });
  const record = await f.service.verification.verify(f.task.id, {
    entry: "contain.py",
    language: "python",
    referenceId: reference.id,
  });
  assert.equal(record.passed, true, JSON.stringify(record));
  assert.equal(await readFile(outside, "utf8"), "PRIVATE CANARY");
  await assert.rejects(readFile(forbidden), { code: "ENOENT" });
  assert.equal(
    await readFile(
      join(record.snapshotDirectory, "Output", "allowed.txt"),
      "utf8",
    ),
    "ok",
  );
});

test("wrong precision and one wrong digit fail the independently generated Pi check", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  const reference = f.service.verification.ensurePiReference(
    500,
    "significant",
  );
  const program = `DIGITS=499\nGUARD=30\ndef atan(x,scale):\n p=scale//x;s=p;d=3;sign=-1\n while p:\n  p//=x*x;t=p//d\n  if not t:break\n  s+=sign*t;sign=-sign;d+=2\n return s\nscale=10**(DIGITS+GUARD)\ns=str((16*atan(5,scale)-4*atan(239,scale))//10**GUARD)\nprint(s[0]+'.'+s[1:])\n`;
  const source = join(f.workspace, "pi.py");
  await writeFile(source, program);
  const spec = {
    entry: "pi.py",
    language: "python",
    referenceId: reference.id,
  };
  const good = await f.service.verification.verify(f.task.id, spec);
  assert.equal(good.passed, true, JSON.stringify(good));
  assert.equal(good.stdout.trimEnd().length, 501);
  await writeFile(source, program.replace("DIGITS=499", "DIGITS=500"));
  assert.equal(
    (await f.service.verification.verify(f.task.id, spec)).passed,
    false,
  );
  await writeFile(source, program.replace("s[1:]", "s[1:-1]+'0'"));
  assert.equal(
    (await f.service.verification.verify(f.task.id, spec)).passed,
    false,
  );
});

test("symlink sources and revoked reads are refused before execution", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.base, "outside.py"), "print('ok')\n");
  await symlink(join(f.base, "outside.py"), join(f.workspace, "link.py"));
  const reference = f.service.verification.registerReference({
    label: "ok",
    stdout: "ok",
  });
  await assert.rejects(
    f.service.verification.verify(f.task.id, {
      entry: "link.py",
      language: "python",
      referenceId: reference.id,
    }),
    /outside|symlink|traverse/,
  );
  await writeFile(join(f.workspace, "local.py"), "print('ok')\n");
  const agent = f.store.get<{ id: string; workspaces: unknown[] }>(
    "agent",
    f.task.agentId,
  );
  f.store.put("agent", { ...agent, workspaces: [] });
  await assert.rejects(
    f.service.verification.verify(f.task.id, {
      entry: "local.py",
      language: "python",
      referenceId: reference.id,
    }),
    /folder|workspace|source/,
  );
  assert.equal(f.store.list("execution-verification").length, 0);
});

test("output overflow and timeout are failures with leases released", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  const reference = f.service.verification.registerReference({
    label: "ok",
    stdout: "ok",
  });
  await writeFile(
    join(f.workspace, "bad.py"),
    "while True: print('x'*10000)\n",
  );
  const overflow = await f.service.verification.verify(f.task.id, {
    entry: "bad.py",
    language: "python",
    referenceId: reference.id,
    timeoutMs: 3000,
  });
  assert.equal(overflow.passed, false);
  assert.match(overflow.reason, /limit|timed out/);
  await writeFile(join(f.workspace, "bad.py"), "while True: pass\n");
  const timeout = await f.service.verification.verify(f.task.id, {
    entry: "bad.py",
    language: "python",
    referenceId: reference.id,
    timeoutMs: 150,
  });
  assert.equal(timeout.passed, false);
  assert.match(timeout.reason, /timed out/);
  assert.equal(f.store.list("slot").length, 0);
  assert.equal(f.store.list("lease").length, 0);
});

test("JavaScript, TypeScript and C++ run with the same confined evidence contract", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  const reference = f.service.verification.registerReference({
    label: "Runtime smoke",
    stdout: "hello",
  });
  for (const [language, entry, source] of [
    ["javascript", "hello.js", "console.log('hello');\n"],
    [
      "typescript",
      "hello.ts",
      "const message: string = 'hello'; console.log(message);\n",
    ],
    [
      "cpp",
      "hello.cpp",
      '#include <iostream>\nint main(){std::cout << "hello\\n";}\n',
    ],
  ] as const) {
    const names = language === "cpp" ? ["clang++", "g++"] : ["node"];
    try {
      await verificationExecutable(names);
    } catch {
      t.diagnostic(
        `${language} toolchain unavailable; that runtime was not exercised`,
      );
      continue;
    }
    await writeFile(join(f.workspace, entry), source);
    const record = await f.service.verification.verify(f.task.id, {
      entry,
      language,
      referenceId: reference.id,
    });
    assert.equal(record.passed, true, JSON.stringify(record));
    assert.equal(record.stdout, "hello\n");
    if (language === "cpp") assert.ok(record.binaryHash?.length === 64);
  }
});

test("cancelling verification terminates its process and releases its lease and slot", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  await writeFile(join(f.workspace, "wait.py"), "while True: pass\n");
  const reference = f.service.verification.registerReference({
    label: "Cancellation",
    stdout: "unreachable",
  });
  const pending = f.service.verification.verify(f.task.id, {
    entry: "wait.py",
    language: "python",
    referenceId: reference.id,
    timeoutMs: 10000,
  });
  const deadline = Date.now() + 3000;
  while (!f.service.verification.cancel(f.task.id) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const record = await pending;
  assert.equal(record.passed, false);
  assert.equal(record.status, "cancelled", JSON.stringify(record));
  assert.equal(f.store.list("slot").length, 0);
  assert.equal(f.store.list("lease").length, 0);
  assert.equal(f.service.verification.cancel(f.task.id), false);
});

test("nested Python entry imports its declared sibling module after integration remapping", async (t) => {
  if (!(await canConfine())) {
    t.skip("mandatory verification sandbox unavailable on this host");
    return;
  }
  const f = await fixture(t);
  await mkdir(join(f.workspace, "python"));
  await writeFile(
    join(f.workspace, "python", "program.py"),
    "from helper import message\nprint(message)\n",
  );
  await writeFile(
    join(f.workspace, "python", "helper.py"),
    "message = 'nested works'\n",
  );
  const reference = f.service.verification.registerReference({
    label: "Nested Python",
    stdout: "nested works",
  });
  const record = await f.service.verification.verify(f.task.id, {
    entry: "python/program.py",
    language: "python",
    referenceId: reference.id,
    sourceFiles: ["python/program.py", "python/helper.py"],
  });
  assert.equal(record.passed, true, JSON.stringify(record));
  assert.equal(record.stdout, "nested works\n");
  assert.deepEqual(
    record.sourceFiles.map((source) => source.path),
    ["python/helper.py", "python/program.py"],
  );
});
