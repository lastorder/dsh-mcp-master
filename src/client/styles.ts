/**
 * Component CSS. Only Harness theme tokens (`--dsw-*`) are referenced, so the
 * picker follows light/dark and brand themes like its neighbour, the
 * composer's model selector (trigger metrics and menu surface copied from it).
 */

export const STYLE_ID = 'dsh-mcp-master/styles';

const MONO = 'var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)';
const FOCUS = 'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))';

export const CSS = `
.mcpm-root{position:relative;min-width:0;display:flex;align-items:center}
.mcpm-trigger{display:flex;align-items:center;gap:5px;min-width:0;height:28px;padding:0 8px 0 7px;border:none;border-radius:var(--dsw-radius-sm,8px);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:400;cursor:pointer;white-space:nowrap}
.mcpm-trigger:hover,.mcpm-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.mcpm-trigger:focus-visible{box-shadow:0 0 0 2px ${FOCUS}}
.mcpm-trigger-label{display:var(--dsh-composer-model-text-display,inline)}
.mcpm-trigger-count{font-variant-numeric:tabular-nums}
.mcpm-trigger-new{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.mcpm-icon{flex:none;display:block}

.mcpm-dot{position:relative;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.mcpm-dot[data-tone="done"]{background:var(--dsw-alias-state-success-primary)}
.mcpm-dot[data-tone="warning"]{background:var(--dsw-alias-state-warn-primary)}
.mcpm-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary)}
.mcpm-dot[data-tone="new"]{background:var(--dsw-alias-brand-primary)}
.mcpm-dot[data-tone="ongoing"]{background:var(--dsw-alias-label-tertiary);animation:mcpm-pulse 1.2s ease-in-out infinite}
@keyframes mcpm-pulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.mcpm-dot[data-tone="ongoing"]{animation:none;opacity:.6}}

.mcpm-panel{position:fixed;z-index:1000;box-sizing:border-box;display:flex;flex-direction:column;width:452px;max-width:calc(100vw - 32px);max-height:min(600px,calc(100vh - 96px));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;text-align:left;-webkit-app-region:no-drag;overflow:hidden}
.mcpm-head{display:flex;align-items:flex-start;gap:6px;padding:12px 10px 6px 16px}
.mcpm-head-text{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.mcpm-title{font-size:14px;font-weight:600;line-height:20px}
.mcpm-subtitle{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcpm-iconbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mcpm-iconbtn:hover,.mcpm-iconbtn:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.mcpm-iconbtn:disabled{opacity:.5;cursor:default}
.mcpm-iconbtn[data-spin="true"] svg{animation:mcpm-spin 1s linear infinite}
@keyframes mcpm-spin{to{transform:rotate(360deg)}}

.mcpm-alert{margin:0 12px 6px;padding:6px 10px;border-radius:10px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);overflow-wrap:anywhere}
.mcpm-alert[data-tone="muted"]{color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.mcpm-alert[data-tone="brand"]{color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}

.mcpm-body{flex:1;min-height:0;overflow:auto;padding:0 6px 6px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.mcpm-group{display:flex;align-items:baseline;gap:6px;margin:8px 10px 3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mcpm-group-title{font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.mcpm-group-file{font-family:${MONO};font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcpm-group-file[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.mcpm-empty{margin:0 10px 6px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mcpm-list{list-style:none;margin:0;padding:0}
.mcpm-row{border-radius:12px}
.mcpm-row[data-open="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.mcpm-line{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 10px;border-radius:12px}
.mcpm-line:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mcpm-main{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mcpm-main:focus-visible{outline:2px solid ${FOCUS};outline-offset:2px;border-radius:6px}
.mcpm-top{display:flex;align-items:center;gap:6px;min-width:0}
.mcpm-name{font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.mcpm-tag{flex:none;padding:0 5px;border-radius:5px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.mcpm-tag[data-kind="default"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.mcpm-status{flex:none;margin-left:auto;padding-left:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mcpm-status[data-tone="done"]{color:var(--dsw-alias-state-success-primary)}
.mcpm-status[data-tone="warning"]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.mcpm-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.mcpm-status[data-tone="new"]{color:var(--dsw-alias-brand-primary)}
.mcpm-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:${MONO}}
.mcpm-sub[data-tone="error"]{color:var(--dsw-alias-state-error-primary);font-family:inherit}
.mcpm-sub[data-tone="hint"]{font-family:inherit}
.mcpm-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s}
.mcpm-chevron[data-open="true"]{transform:rotate(180deg)}

.mcpm-check{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:1.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary-foreground);cursor:pointer}
.mcpm-check[aria-checked="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.mcpm-check:disabled{opacity:.45;cursor:default}
.mcpm-check:focus-visible{outline:2px solid ${FOCUS};outline-offset:2px}

.mcpm-btn{display:inline-flex;align-items:center;gap:4px;flex:none;height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:16px;cursor:pointer;white-space:nowrap;text-decoration:none}
.mcpm-btn:hover,.mcpm-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.mcpm-btn:disabled{opacity:.5;cursor:default}
.mcpm-btn[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.mcpm-btn[data-variant="primary"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-label-primary))}
.mcpm-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary)}
.mcpm-linkbtn{padding:0;border:0;background:none;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));font:inherit;font-size:11px;cursor:pointer}
.mcpm-linkbtn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}

.mcpm-trust{margin:0 10px 8px 34px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);display:flex;flex-direction:column;gap:6px}
.mcpm-trust-title{font-weight:600;font-size:12.5px}
.mcpm-trust-body{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mcpm-code{display:block;padding:6px 8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);font-family:${MONO};font-size:11px;line-height:15px;overflow-wrap:anywhere;white-space:pre-wrap}

.mcpm-detail{display:flex;flex-direction:column;gap:8px;padding:2px 12px 12px 34px}
.mcpm-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;margin:0;font-size:11.5px;line-height:16px}
.mcpm-facts dt{color:var(--dsw-alias-label-tertiary)}
.mcpm-facts dd{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mcpm-mono{font-family:${MONO};font-size:11px}
.mcpm-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mcpm-hint[data-tone="error"]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.mcpm-hint[data-tone="warning"]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.mcpm-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}
.mcpm-tools{display:flex;flex-wrap:wrap;gap:4px}
.mcpm-tool{max-width:100%;padding:1px 6px;border-radius:6px;font-family:${MONO};font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default}
.mcpm-tool[data-readonly="true"]::after{content:" ·ro";color:var(--dsw-alias-label-tertiary)}
.mcpm-actions{display:flex;flex-wrap:wrap;gap:6px}
.mcpm-logs{margin:0;max-height:180px;overflow:auto;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);font-family:${MONO};font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}

.mcpm-foot{display:flex;flex-direction:column;gap:6px;padding:8px 14px 12px 16px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mcpm-foot-row{display:flex;align-items:center;gap:8px}
.mcpm-foot-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.mcpm-foot-hint{font-size:11px}
`;
