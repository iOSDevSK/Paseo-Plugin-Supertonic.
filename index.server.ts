import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  SUPERTONIC_BASE_URL,
  preferences,
  previewRpc,
  restartRpc,
  statusRpc,
  syncRpc,
  type Preferences,
} from "./shared/contracts";
import { AppleStt } from "./server/apple-stt";
import { SupertonicRuntime } from "./server/runtime";
import { readLinkState, syncVoiceConfig } from "./server/voice-config";

export default function contribute(server: PluginServerContext) {
  const runtime = new SupertonicRuntime();
  const appleStt = new AppleStt();
  const settings = server.registerSettings(preferences);
  let paseo: PluginHandlerContext["paseo"] | null = null;
  let current: Preferences | null = null;
  let syncing: Promise<unknown> = Promise.resolve();
  let disposed = false;

  // Config writes are serialized so overlapping setting changes cannot interleave patches.
  function sync(): Promise<boolean> {
    const run = syncing.then(async () => {
      if (disposed || !paseo || !current) return false;
      try {
        await syncVoiceConfig(paseo, current, { sttReady: appleStt.phase === "ready" });
        return true;
      } catch (error) {
        console.error("[supertonic] Failed to update voice config", error);
        return false;
      }
    });
    syncing = run;
    return run;
  }

  async function apply(next: Preferences): Promise<void> {
    if (disposed) return;
    const previous = current;
    current = next;
    if (next.enabled && !runtime.running) void runtime.start();
    if (!next.enabled && previous?.enabled) await runtime.stop();
    await runtime.applyPreferences(next).catch(() => {});

    appleStt.setLanguage(next.lang);
    if (next.appleStt && appleStt.phase !== "ready") void appleStt.start().then(sync);
    if (!next.appleStt && appleStt.phase !== "stopped") await appleStt.stop();
    await sync();
  }

  void settings.read().then((state) => {
    if (state.status === "ready") return apply(state.values);
    console.error("[supertonic] Stored settings are invalid:", state.error);
    return undefined;
  });
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") return apply(state.values);
    return undefined;
  });

  // The server entry has no Paseo connection outside handlers; the client calls this RPC on load,
  // which hands over the subprocess-lifetime API used to keep speech config in sync.
  server.handle(syncRpc, async (_input, context) => {
    paseo = context.paseo;
    await sync();
    return { voiceModeLinked: (await readLinkState(context.paseo)).voiceModeLinked };
  });

  server.handle(statusRpc, async (_input, context) => {
    paseo ??= context.paseo;
    const links = await readLinkState(context.paseo).catch(() => ({
      voiceModeLinked: false,
      sttLinked: false,
    }));
    return {
      phase: runtime.phase,
      message: runtime.message,
      baseUrl: SUPERTONIC_BASE_URL,
      voiceModeLinked: links.voiceModeLinked,
      stt: { phase: appleStt.phase, message: appleStt.message, linked: links.sttLinked },
      logTail: runtime.logTail,
    };
  });

  server.handle(previewRpc, async ({ text }) => {
    const wav = await runtime.synthesizeWav(text);
    return { base64: wav.toString("base64"), mimeType: "audio/wav" };
  });

  server.handle(restartRpc, async ({ reinstall }) => {
    void runtime.start({ reinstall });
    if (current?.appleStt) void appleStt.stop().then(() => appleStt.start()).then(sync);
    return {};
  });

  // Unlink Paseo speech sites when the plugin stops so Paseo does not talk to closed ports. The
  // next client load links them again through the sync RPC.
  return async () => {
    unsubscribe();
    disposed = true;
    const api = paseo;
    const last = current;
    await Promise.all([runtime.stop(), appleStt.stop()]);
    // Queued behind any in-flight sync; later syncs see `disposed` and do nothing.
    syncing = syncing.then(async () => {
      if (!api || !last) return;
      await syncVoiceConfig(api, { ...last, enabled: false, appleStt: false }, { sttReady: false }).catch(
        (error) => console.error("[supertonic] Failed to restore voice config", error),
      );
    });
    await syncing;
  };
}
