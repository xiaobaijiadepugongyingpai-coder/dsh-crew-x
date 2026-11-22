// Pure view helpers for Antigravity tiered MCP permission allowlisting and
// Desktop App UI rule text generation in the DSH Crew settings panel.

export const AGY_SAFE_PERMISSION_RULES = [
  'mcp(dsh-crew/dsh_worker_status)',
  'mcp(dsh-crew/dsh_worker_result)',
  'mcp(dsh-crew/dsh_worker_config)',
  'mcp(dsh-crew/dsh_worker_probe)',
] as const;

export const AGY_DISPATCH_PERMISSION_RULES = [
  'mcp(dsh-crew/dsh_run_worker)',
  'mcp(dsh-crew/dsh_spawn_worker)',
  'mcp(dsh-crew/dsh_worker_cancel)',
] as const;

export const AGY_ALL_PERMISSION_RULES = [
  ...AGY_SAFE_PERMISSION_RULES,
  ...AGY_DISPATCH_PERMISSION_RULES,
] as const;

export type AgyPermissionMode = 'none' | 'safe' | 'dispatch' | 'all';

export function agyPermissionMode(allowSafe: boolean, allowDispatch: boolean): AgyPermissionMode {
  if (allowSafe && allowDispatch) return 'all';
  if (allowSafe) return 'safe';
  if (allowDispatch) return 'dispatch';
  return 'none';
}

export function agyPermissionRulesFor(allowSafe: boolean, allowDispatch: boolean): string[] {
  return [
    ...(allowSafe ? AGY_SAFE_PERMISSION_RULES : []),
    ...(allowDispatch ? AGY_DISPATCH_PERMISSION_RULES : []),
  ];
}

export function agyDesktopPermissionsText(allowSafe: boolean, allowDispatch: boolean): string {
  return agyPermissionRulesFor(allowSafe, allowDispatch).join('\n');
}

export function agyInitialPermissionSelection(agyStatus: any): { allowSafe: boolean; allowDispatch: boolean } {
  if (agyStatus?.installed && agyStatus?.permissions) {
    return {
      allowSafe: Boolean(agyStatus.permissions.allowSafe),
      allowDispatch: Boolean(agyStatus.permissions.allowDispatch),
    };
  }
  return { allowSafe: true, allowDispatch: false };
}
