// Every section of the Settings page and the settings in it, in page order. The page uses it
// for its headings, and the sidebar search uses it to find a setting by name.

export interface SettingsSection {
  id: string;
  title: string;
  group: string;
  /** The settings in this section, as named on the page. */
  items: string[];
  /** Other words people might type for this section. */
  keywords?: string;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "providers", group: "Models", title: "Model providers", items: ["OpenRouter key", "Ollama base URL", "OpenAI-compatible base URL"], keywords: "api key lm studio llama local endpoint" },
  { id: "defaults", group: "Models", title: "Default models", items: ["Chat model", "Tasks model", "Reflector model", "Judge model"], keywords: "default model" },
  { id: "profile", group: "Models", title: "Model profile", items: ["Strategy", "Escalate to", "Few-shot examples", "Context window", "Native tool calling"], keywords: "cascade tokens tools" },
  { id: "approvals", group: "Running", title: "Tool approvals", items: ["YOLO mode", "YOLO for scheduled Tasks"], keywords: "permissions ask first powershell shell" },
  { id: "long", group: "Running", title: "Long tasks", items: ["Steps for a quick request", "Spend for a quick request", "Minutes for a quick request", "Steps for a long task", "Minutes for a long task", "Spend for a long task", "Review a run after failed calls", "Git checkpoints", "Load app tools on demand", "Commands scheduled Tasks may run", "Always-allowed commands"], keywords: "limits cap timeout" },
  { id: "budgets", group: "Running", title: "Daily budgets", items: ["Chat budget", "Tasks budget", "Evolve budget"], keywords: "usd money spend cost" },
  { id: "connectors", group: "Apps and devices", title: "Connectors", items: ["Google Workspace and other apps"], keywords: "gmail google calendar drive" },
  { id: "extensions", group: "Apps and devices", title: "Extensions and MCP", items: ["Extensions", "MCP servers"], keywords: "plugins" },
  { id: "phone", group: "Apps and devices", title: "Phone", items: ["Pair a phone", "Paired phones"], keywords: "iphone qr mobile" },
  { id: "appearance", group: "Syph", title: "Appearance", items: ["Dark theme", "Safe mode", "Interface changes", "Reset interface"], keywords: "light dark theme ui buttons" },
  { id: "evolve", group: "Syph", title: "Self-improvement", items: ["Auto-accept memory", "Auto-accept skills", "Samples per eval case", "Kill switch"], keywords: "evolve evals" },
  { id: "data", group: "Syph", title: "Data", items: ["Export training data"], keywords: "jsonl fine-tune sft dpo" },
];
