import { spawnProcess, execCommand, terminateProcess } from "@getpaseo/plugin/server";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SUPERTONIC_MODEL, SUPERTONIC_PORT, type Preferences } from "../shared/contracts";
import { ADAPTER_SOURCE } from "./adapter-source";

export type Phase = "installing" | "loading" | "ready" | "error" | "stopped";

// Bump when the Python dependencies change so existing environments are rebuilt.
const ENV_REVISION = "supertonic==1.3.1;numpy;rev1";
const PYTHON_VERSION = "3.12";
const LOG_LIMIT = 80;
const ORIGIN = `http://127.0.0.1:${SUPERTONIC_PORT}`;

export function dataDirectory(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-data", "supertonic");
}

function findUv(): string | null {
  const candidates = [
    join(homedir(), ".local", "bin", "uv"),
    join(homedir(), ".cargo", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir) candidates.push(join(dir, "uv"));
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}

export class SupertonicRuntime {
  phase: Phase = "stopped";
  message = "Zastavené";
  private readonly dir = dataDirectory();
  private readonly venv = join(this.dir, "venv");
  private child: ChildProcess | null = null;
  private logs: string[] = [];
  private stopping = false;
  private generation = 0;
  private crashes = 0;
  private preferences: Preferences | null = null;
  private starting: Promise<void> = Promise.resolve();

  get logTail(): string[] {
    return this.logs.slice(-20);
  }

  get running(): boolean {
    return this.phase === "installing" || this.phase === "loading" || this.phase === "ready";
  }

  // Starts are serialized so a reinstall cannot delete the venv under a running install.
  start(options: { reinstall?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.stopping = false;
    this.starting = this.starting.then(() => this.startNow(generation, options));
    return this.starting;
  }

  private async startNow(generation: number, options: { reinstall?: boolean }): Promise<void> {
    if (generation !== this.generation) return;
    try {
      await this.killChild();
      await this.evictStaleAdapter();
      if (options.reinstall) await rm(this.venv, { recursive: true, force: true });
      await this.ensureEnvironment();
      if (generation !== this.generation) return;
      await this.spawnAdapter(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.setPhase("error", error instanceof Error ? error.message : String(error));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    await this.killChild();
    this.setPhase("stopped", "Zastavené");
  }

  async applyPreferences(preferences: Preferences): Promise<void> {
    this.preferences = preferences;
    if (this.phase !== "ready") return;
    await this.request("/config", {
      voice: preferences.voice,
      lang: preferences.lang,
      speed: preferences.speed,
      steps: preferences.steps,
    });
  }

  async synthesizeWav(text: string): Promise<Buffer> {
    if (this.phase !== "ready") throw new Error(`Supertonic nie je pripravený: ${this.message}`);
    const response = await fetch(`${ORIGIN}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: SUPERTONIC_MODEL, input: text, response_format: "wav" }),
    });
    if (!response.ok) throw new Error(`Supertonic vrátil ${response.status}: ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async ensureEnvironment(): Promise<void> {
    const python = join(this.venv, "bin", "python");
    const marker = join(this.venv, ".paseo-supertonic");
    if (existsSync(python) && (await readFile(marker, "utf8").catch(() => "")) === ENV_REVISION) {
      return;
    }
    await mkdir(this.dir, { recursive: true });
    await rm(this.venv, { recursive: true, force: true });
    const uv = findUv();
    this.setPhase("installing", "Pripravujem Python prostredie so Supertonicom");
    if (uv) {
      await this.run(uv, ["venv", "--python", PYTHON_VERSION, this.venv]);
      await this.run(uv, ["pip", "install", "--python", python, "supertonic==1.3.1", "numpy"]);
    } else {
      await this.run("python3", ["-m", "venv", this.venv]);
      await this.run(python, ["-m", "pip", "install", "supertonic==1.3.1", "numpy"]);
    }
    await writeFile(marker, ENV_REVISION);
  }

  private async run(command: string, args: string[]): Promise<void> {
    this.log(`$ ${command} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await execCommand(command, args, {
        timeout: 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const line of `${stdout}\n${stderr}`.split("\n")) if (line.trim()) this.log(line);
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      for (const line of (detail.stderr ?? "").split("\n")) if (line.trim()) this.log(line);
      throw new Error(`Inštalácia zlyhala: ${detail.message ?? String(error)}`);
    }
  }

  private async spawnAdapter(generation: number): Promise<void> {
    const script = join(this.dir, "adapter.py");
    await writeFile(script, ADAPTER_SOURCE);
    this.setPhase("loading", "Načítavam model (prvé spustenie sťahuje asi 400 MB)");
    const child = spawnProcess(
      join(this.venv, "bin", "python"),
      ["-u", script, String(SUPERTONIC_PORT), SUPERTONIC_MODEL],
      { stdio: "pipe", env: { ...process.env, PYTHONUNBUFFERED: "1" } },
    );
    this.child = child;
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) this.log(line);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping || generation !== this.generation) return;
      this.crashes++;
      this.log(`Adapter exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      if (this.crashes <= 3) {
        this.setPhase("loading", "Adaptér spadol, spúšťam znova");
        setTimeout(() => {
          if (generation === this.generation) void this.spawnAdapter(generation);
        }, 2000 * this.crashes);
      } else {
        this.setPhase("error", "Adaptér opakovane padá. Pozri logy pluginu.");
      }
    });
    void this.waitUntilReady(generation, child);
  }

  private async waitUntilReady(generation: number, child: ChildProcess): Promise<void> {
    while (generation === this.generation && this.child === child) {
      const health = (await this.request("/health").catch(() => null)) as {
        phase?: string;
        message?: string;
      } | null;
      if (health?.phase === "ready") {
        this.crashes = 0;
        this.setPhase("ready", "Beží");
        if (this.preferences) await this.applyPreferences(this.preferences).catch(() => {});
        return;
      }
      if (health?.phase === "error") {
        this.setPhase("error", health.message ?? "Model sa nepodarilo načítať");
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await terminateProcess(child);
    await exited;
  }

  // An adapter left behind by a crashed host would hold the port; ask it to exit first.
  private async evictStaleAdapter(): Promise<void> {
    if (!(await this.request("/health").catch(() => null))) return;
    this.log("Found a running adapter on the port, asking it to exit");
    await this.request("/shutdown", {}).catch(() => null);
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (!(await this.request("/health").catch(() => null))) return;
    }
    throw new Error(`Port ${SUPERTONIC_PORT} je obsadený iným procesom`);
  }

  private setPhase(phase: Phase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.log(`[${phase}] ${message}`);
  }

  private log(line: string): void {
    console.log(`[supertonic] ${line}`);
    this.logs.push(line);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
  }
}
