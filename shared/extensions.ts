/** Global author-managed extensions. Only summaries enter the first model request. */
export interface ScriptTool {
  id: string; name: string; description: string; enabled: boolean;
  inputSchema: Record<string, unknown>; code: string; timeoutMs: number;
}
export interface McpToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpConnection {
  id: string; name: string; description: string; enabled: boolean;
  transport: 'stdio' | 'http'; command: string; args: string[]; url: string;
  env: Record<string, string>; headers: Record<string, string>;
  hasSecrets?: boolean; clearSecrets?: boolean; timeoutMs: number;
  tools: McpToolDefinition[]; discoveredAt?: string;
}
export interface SkillFile { path: string; content: string; encoding: 'utf8' | 'base64' }
export interface ImportedSkill {
  id: string; name: string; description: string; enabled: boolean;
  files: SkillFile[];
}
export interface ExtensionSettings {
  revision: string; scripts: ScriptTool[]; mcpServers: McpConnection[]; skills: ImportedSkill[];
}
export interface ExtensionSummary { id: string; kind: 'script' | 'mcp' | 'skill'; name: string; description: string }
export const emptyExtensions = (): ExtensionSettings => ({ revision: '0', scripts: [], mcpServers: [], skills: [] });
export const EXAMPLE_SCRIPT = `// args 是符合参数格式的 JSON 对象；return 的值会返回给 AI。
const text = String(args.text ?? '');
return { characters: Array.from(text.replace(/\\s/g, '')).length };`;
export const EXAMPLE_SCRIPT_SCHEMA = { type: 'object', properties: { text: { type: 'string', description: '需要统计的文字' } }, required: ['text'], additionalProperties: false };
