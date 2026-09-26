import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { applyColors } from "./colors.js";
import type { GetExtensionStatuses } from "./extension-statuses.js";
import { separatorText } from "./separators.js";
import type { StatuslineData, StatuslineSettings } from "./types.js";
import { contextForDependencies } from "./widgets/context.js";
import { registry } from "./widgets/registry.js";
import type { WidgetStore } from "./widgets/store.js";
import type { BaseWidgetContext, Widget } from "./widgets/types.js";

export interface RenderStatuslineOptions {
  getExtensionStatuses?: GetExtensionStatuses;
  theme?: Theme;
  requestRender?: () => void;
}

export function renderStatuslines(
  store: WidgetStore,
  data: StatuslineData,
  width: number,
  options: RenderStatuslineOptions = {},
): string[] {
  const settings = store.settings;
  if (!settings.enabled || width <= 0) return [];

  const baseCtx: BaseWidgetContext = {
    iconMode: settings.iconMode,
    minimalist: settings.minimalist,
    colorLevel: settings.terminal.colorLevel,
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.requestRender ? { requestRender: options.requestRender } : {}),
  };
  const lineWidth = effectiveWidth(settings, width);
  return store.lines
    .map((line) => renderLine(line, settings, lineWidth, { baseCtx, data, options }))
    .filter((line) => line.trim().length > 0);
}

function padRight(left: string, right: string, width: number): string {
  const spaces = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  // Widget output normally closes its styles, but explicit reset keeps flex padding neutral
  // when a terminal or third-party ANSI string leaves a background color active.
  const reset = "\x1b[0m";
  return truncateToWidth(`${left}${reset}${" ".repeat(spaces)}${reset}${right}`, width, "…");
}

interface RenderedSegment {
  widget: Widget;
  segment: string;
}

function isLayoutWidget(entry: RenderedSegment): boolean {
  return ["separator", "spacer", "flex-separator"].includes(entry.widget.type);
}

function responsiveSegments(
  rendered: readonly RenderedSegment[],
  settings: StatuslineSettings,
  width: number,
): RenderedSegment[] {
  if (settings.terminal.responsiveMode !== "hide-low-priority") return [...rendered];

  const hidden = new Set<string>();
  const candidates = rendered
    .filter((entry) => entry.segment.length > 0 && !isLayoutWidget(entry))
    .sort(
      (left, right) =>
        (Number(left.widget.options.responsivePriority) || 50) -
          (Number(right.widget.options.responsivePriority) || 50) ||
        rendered.indexOf(right) - rendered.indexOf(left),
    );

  for (const candidate of candidates) {
    const visible = cleanLayout(
      rendered.filter((entry) => !hidden.has(entry.widget.id)),
      rendered,
    );
    if (visibleLineWidth(visible, settings) <= width) return visible;
    hidden.add(candidate.widget.id);
  }
  return cleanLayout(rendered.filter((entry) => !hidden.has(entry.widget.id)), rendered);
}

function cleanLayout(
  entries: readonly RenderedSegment[],
  allEntries: readonly RenderedSegment[] = entries,
): RenderedSegment[] {
  const visibleIds = new Set(entries.map((entry) => entry.widget.id));
  return entries.filter((entry, index) => {
    if (entry.segment.length === 0) return false;
    if (entry.widget.type === "flex-separator") {
      return (
        entries.slice(0, index).some((item) => !isLayoutWidget(item) && item.segment.length > 0) &&
        entries.slice(index + 1).some((item) => !isLayoutWidget(item) && item.segment.length > 0)
      );
    }
    if (entry.widget.type !== "separator" && entry.widget.type !== "spacer") return true;
    const originalIndex = allEntries.findIndex((item) => item.widget.id === entry.widget.id);
    const left = allEntries
      .slice(0, originalIndex)
      .reverse()
      .find((item) => !isLayoutWidget(item) && item.segment.length > 0);
    const right = allEntries
      .slice(originalIndex + 1)
      .find((item) => !isLayoutWidget(item) && item.segment.length > 0);
    const hasLeft = left !== undefined && visibleIds.has(left.widget.id);
    const hasRight = right !== undefined && visibleIds.has(right.widget.id);
    const separator = String(entry.widget.options.separator ?? "");
    if (separator === "powerline-start") return hasRight;
    if (separator === "powerline-end") return hasLeft;
    return hasLeft && hasRight;
  });
}

function visibleLineWidth(entries: readonly RenderedSegment[], settings: StatuslineSettings): number {
  const flexIndex = entries.findIndex((entry) => entry.widget.type === "flex-separator");
  if (flexIndex === -1) return visibleWidth(joinSegments(entries, settings));
  const left = joinSegments(entries.slice(0, flexIndex), settings);
  const right = joinSegments(entries.slice(flexIndex + 1), settings);
  return visibleWidth(left) + (right ? 1 + visibleWidth(right) : 0);
}

interface RenderLineContext {
  baseCtx: BaseWidgetContext;
  data: StatuslineData;
  options: RenderStatuslineOptions;
}

function renderLine(
  line: readonly Widget[],
  settings: StatuslineSettings,
  width: number,
  ctx: RenderLineContext,
): string {
  const rendered = line
    .filter((widget) => widget.enabled)
    .map((widget) => ({
      widget,
      segment:
        widget.render(
          contextForDependencies(
            ctx.baseCtx,
            registry.spec(widget.type).dependencies,
            ctx.data,
            ctx.options,
          ),
        ) ?? "",
    }));

  const responsive = responsiveSegments(rendered, settings, width);
  const flexIndex = responsive.findIndex((entry) => entry.widget.type === "flex-separator");
  if (flexIndex === -1) {
    return truncateToWidth(joinSegments(responsive, settings), width, "…");
  }

  const left = joinSegments(responsive.slice(0, flexIndex), settings);
  const right = joinSegments(responsive.slice(flexIndex + 1), settings);
  return right ? padRight(left, right, width) : truncateToWidth(left, width, "…");
}

function effectiveWidth(settings: StatuslineSettings, width: number): number {
  if (settings.terminal.widthMode === "full-minus-40") return Math.max(1, width - 40);
  return width;
}

function joinSegments(entries: readonly RenderedSegment[], settings: StatuslineSettings): string {
  const segments = entries.filter((entry) => entry.segment.length > 0);
  if (segments.length === 0) return "";

  let output = segments[0]?.segment ?? "";
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (!previous || !current) continue;
    if (previous.widget.type !== "separator" && current.widget.type !== "separator") {
      output += applyColors(
        separatorText(settings.separator),
        settings.separatorFg,
        settings.separatorBg,
        false,
        settings.terminal.colorLevel,
      );
    }
    output += current.segment;
  }
  return output;
}
