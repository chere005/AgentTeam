import test from "node:test";
import assert from "node:assert/strict";
import { languageForPath } from "../ui/editor-languages.ts";

const id = (path: string) => languageForPath(path).id;

test("common project languages map from their extensions", () => {
  const table: Record<string, string> = {
    "a.c": "cpp",
    "a.h": "cpp",
    "a.cpp": "cpp",
    "a.cxx": "cpp",
    "a.hh": "cpp",
    "a.cs": "csharp",
    "a.go": "go",
    "a.rs": "rust",
    "a.java": "java",
    "a.kt": "kotlin",
    "a.kts": "kotlin",
    "a.swift": "swift",
    "a.py": "python",
    "a.ts": "typescript",
    "a.tsx": "typescript",
    "a.js": "javascript",
    "a.jsx": "javascript",
    "a.mjs": "javascript",
    "a.json": "json",
    "a.yaml": "yaml",
    "a.yml": "yaml",
    "a.toml": "toml",
    "a.md": "markdown",
    "a.sh": "shell",
    "a.php": "php",
    "a.sql": "sql",
    "a.html": "html",
    "a.css": "css",
    "a.xml": "xml",
    "a.wl": "wolfram",
    "a.wls": "wolfram",
    "a.rb": "ruby",
    "a.lua": "lua",
    "a.ps1": "powershell",
    "a.proto": "protobuf",
    "a.m": "objc",
    "a.scala": "scala",
    "a.dart": "dart",
    "a.hs": "haskell",
    "a.jl": "julia",
    "a.R": "r",
    "a.gradle": "groovy",
    "a.ini": "properties",
  };
  for (const [path, want] of Object.entries(table))
    assert.equal(id(path), want, path);
});

test("case, directories and Windows separators do not matter", () => {
  assert.equal(id("/src/Main.GO"), "go");
  assert.equal(id("C:\\work\\App.Swift"), "swift");
  assert.equal(id("dir.v/readme"), "plain");
});

test("whole file names", () => {
  assert.equal(id("Dockerfile"), "dockerfile");
  assert.equal(id("sub/Dockerfile.dev"), "dockerfile");
  assert.equal(id("CMakeLists.txt"), "cmake");
  assert.equal(id("x.cmake.in"), "cmake");
  assert.equal(id("PKGBUILD"), "shell");
  assert.equal(id("Gemfile"), "ruby");
  assert.equal(id(".bashrc"), "shell");
});

test("a double extension wins over the last one; unknown stays plain text", () => {
  assert.equal(id("init.m.wl"), "wolfram");
  assert.equal(id("notes.txt"), "plain");
  assert.equal(id("LICENSE"), "plain");
  assert.equal(id("archive.tar.gz"), "plain");
  assert.equal(languageForPath("a.cpp").name, "C / C++");
  assert.equal(languageForPath("a.txt").name, "Plain text");
});
