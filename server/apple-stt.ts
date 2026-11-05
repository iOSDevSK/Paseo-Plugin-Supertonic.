import { execCommand } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { APPLE_STT_MODEL, APPLE_STT_PORT } from "../shared/contracts";
import { APPLE_STT_BINARY_BASE64 } from "./apple-stt-binary";
import { dataDirectory } from "./runtime";

type UploadedFile = { name?: string; arrayBuffer(): Promise<ArrayBuffer> };

export type AppleSttPhase = "loading" | "ready" | "error" | "stopped";

function speechLanguage(lang: string): string {
  // Apple has no automatic language detection; fall back to the system language.
  return lang === "na" ? Intl.DateTimeFormat().resolvedOptions().locale : lang;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

// Serves OpenAI-compatible POST /v1/audio/transcriptions for Paseo dictation and voice mode by
// running the bundled DictationTranscriber helper on each uploaded clip.
export class AppleStt {
  phase: AppleSttPhase = "stopped";
  message = "Vypnuté";
  private server: Server | null = null;
  private binary = join(dataDirectory(), "apple-stt");
  private lang = "sk";
  private starting: Promise<void> | null = null;

  // Switching language keeps the server up; the helper only fetches the new on-device model.
  setLanguage(lang: string): void {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.phase !== "ready") return;
    void this.helper(["prepare", speechLanguage(lang)]).catch((error) => {
      console.error("[supertonic] Apple STT could not prepare", lang, error);
    });
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.startNow().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startNow(): Promise<void> {
    this.phase = "loading";
    this.message = "Pripravujem Apple rozpoznávanie reči";
    try {
      if (process.platform !== "darwin") throw new Error("Apple rozpoznávanie reči funguje len na macOS");
      await this.installBinary();
      const prepared = this.lang;
      await this.helper(["prepare", speechLanguage(prepared)]);
      this.server = await this.listen();
      this.phase = "ready";
      // The language changed while the first model was preparing.
      if (prepared !== this.lang) void this.helper(["prepare", speechLanguage(this.lang)]).catch(() => {});
      this.message = "Beží";
    } catch (error) {
      this.phase = "error";
      this.message = error instanceof Error ? error.message : String(error);
      console.error("[supertonic] Apple STT failed to start:", this.message);
    }
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.phase = "stopped";
    this.message = "Vypnuté";
  }

  private async installBinary(): Promise<void> {
    const bytes = Buffer.from(APPLE_STT_BINARY_BASE64, "base64");
    const existing = await readFile(this.binary).catch(() => null);
    const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    if (existing && digest(existing) === digest(bytes)) return;
    await mkdir(dataDirectory(), { recursive: true });
    await writeFile(this.binary, bytes);
    await chmod(this.binary, 0o755);
  }

  private async helper(args: string[]): Promise<Record<string, unknown>> {
    let stdout: string;
    try {
      ({ stdout } = await execCommand(this.binary, args, { timeout: 10 * 60_000 }));
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? "";
      if (!stdout) throw error;
    }
    const result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
    if (typeof result.error === "string") throw new Error(result.error);
    return result;
  }

  private listen(): Promise<Server> {
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        console.error("[supertonic] Apple STT request failed", error);
        sendJson(response, 500, { error: { message: String(error), type: "server_error" } });
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "EADDRINUSE" ? new Error(`Port ${APPLE_STT_PORT} je obsadený`) : error),
      );
      server.listen(APPLE_STT_PORT, "127.0.0.1", () => resolve(server));
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0].replace(/\/$/, "");
    if (request.method === "GET" && path === "/v1/models") {
      sendJson(response, 200, { object: "list", data: [{ id: APPLE_STT_MODEL, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || path !== "/v1/audio/transcriptions") {
      sendJson(response, 404, { error: { message: "Not found" } });
      return;
    }
    const body = await readBody(request);
    // Node's undici parses the multipart upload; the DOM-free typings lack FormData.get.
    const form = (await new Response(body, {
      headers: { "content-type": request.headers["content-type"] ?? "" },
    }).formData()) as unknown as { get(name: string): UploadedFile | string | null };
    const file = form.get("file");
    if (!file || typeof file === "string") {
      sendJson(response, 400, { error: { message: "Missing audio file" } });
      return;
    }
    const name = file.name ?? "audio.wav";
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ".wav";
    const clip = join(tmpdir(), `paseo-apple-stt-${randomUUID()}${extension}`);
    try {
      await writeFile(clip, Buffer.from(await file.arrayBuffer()));
      const result = await this.helper(["transcribe", clip, speechLanguage(this.lang)]);
      sendJson(response, 200, { text: typeof result.text === "string" ? result.text : "" });
    } finally {
      await rm(clip, { force: true });
    }
  }
}
