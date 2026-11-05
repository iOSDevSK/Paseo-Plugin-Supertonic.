import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SUPERTONIC_PORT = 47788;
export const SUPERTONIC_BASE_URL = `http://127.0.0.1:${SUPERTONIC_PORT}/v1`;
export const SUPERTONIC_MODEL = "supertonic-3";

export const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] as const;

export const LANGUAGES = [
  ["sk", "Slovenčina"],
  ["cs", "Čeština"],
  ["en", "English"],
  ["de", "Deutsch"],
  ["hu", "Magyar"],
  ["pl", "Polski"],
  ["uk", "Українська"],
  ["ru", "Русский"],
  ["fr", "Français"],
  ["es", "Español"],
  ["it", "Italiano"],
  ["pt", "Português"],
  ["nl", "Nederlands"],
  ["da", "Dansk"],
  ["sv", "Svenska"],
  ["fi", "Suomi"],
  ["et", "Eesti"],
  ["lv", "Latviešu"],
  ["lt", "Lietuvių"],
  ["sl", "Slovenščina"],
  ["hr", "Hrvatski"],
  ["bg", "Български"],
  ["ro", "Română"],
  ["el", "Ελληνικά"],
  ["tr", "Türkçe"],
  ["ar", "العربية"],
  ["hi", "हिन्दी"],
  ["id", "Bahasa Indonesia"],
  ["vi", "Tiếng Việt"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["na", "Automaticky (neznámy jazyk)"],
] as const;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    voice: z.enum(VOICES).default("F1"),
    lang: z.string().default("sk"),
    speed: z.number().min(0.7).max(2).default(1.05),
    steps: z.number().int().min(2).max(12).default(8),
  }),
});

export type Preferences = z.output<typeof preferences.schema>;

const PhaseSchema = z.enum(["installing", "loading", "ready", "error", "stopped"]);

export const statusRpc = defineRpc({
  name: "supertonic.status",
  input: z.object({}),
  output: z.object({
    phase: PhaseSchema,
    message: z.string(),
    baseUrl: z.string(),
    voiceModeLinked: z.boolean(),
    logTail: z.array(z.string()),
  }),
});

export const syncRpc = defineRpc({
  name: "supertonic.sync",
  input: z.object({}),
  output: z.object({ voiceModeLinked: z.boolean() }),
});

export const previewRpc = defineRpc({
  name: "supertonic.preview",
  input: z.object({ text: z.string().min(1).max(500) }),
  output: z.object({ base64: z.string(), mimeType: z.string() }),
});

export const restartRpc = defineRpc({
  name: "supertonic.restart",
  input: z.object({ reinstall: z.boolean().default(false) }),
  output: z.object({}),
});
