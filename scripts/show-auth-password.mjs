import { loadRuntimeSettings } from "./runtime-settings.mjs";

const settings = await loadRuntimeSettings();
console.log(settings.authPassword);
