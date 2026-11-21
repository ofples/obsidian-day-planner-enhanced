/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import { Notice } from "obsidian";
import { on } from "svelte/events";
import { isNotVoid } from "typed-assert";

import {
  scrollOnHoverZoneHeightPercent,
  scrollSpeedPixelsPerAnimationFrame,
} from "../constants";

export function isHTMLElement(value: unknown): value is HTMLElement {
  if (!value || typeof value !== "object") {
    return false;
  }

  const node = value as Node;

  if (typeof node.instanceOf === "function") {
    return node.instanceOf(HTMLElement);
  }

  return (
    value instanceof (node.ownerDocument?.defaultView ?? window).HTMLElement
  );
}

export function isElement(value: unknown): value is Element {
  if (!value || typeof value !== "object") {
    return false;
  }

  const node = value as Node;

  if (typeof node.instanceOf === "function") {
    return node.instanceOf(Element);
  }

  return value instanceof (node.ownerDocument?.defaultView ?? window).Element;
}

const interactiveElementSelector = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  '[contenteditable="true"]',
  '[role="button"]',
].join(", ");

export function isInteractiveEventTarget(target: EventTarget | null) {
  return (
    isElement(target) && target.closest(interactiveElementSelector) !== null
  );
}

export function isTouchEvent(event: PointerEvent) {
  return ["pen", "touch"].includes(event.pointerType);
}

export function getIsomorphicClientY(
  event: PointerEvent | MouseEvent | TouchEvent,
) {
  if (event instanceof PointerEvent || event instanceof MouseEvent) {
    return event.clientY;
  }

  const firstTouch = event.touches[0] ?? event.changedTouches[0];

  isNotVoid(firstTouch);

  return firstTouch.clientY;
}

export function isEventRelated(
  event: PointerEvent,
  otherNode: HTMLElement | null,
) {
  if (!otherNode) {
    return false;
  }

  return (
    event.relatedTarget &&
    (event.relatedTarget === otherNode ||
      (event.relatedTarget instanceof Node &&
        otherNode.contains(event.relatedTarget)))
  );
}

export function isEventOutside(
  event: PointerEvent,
  container: HTMLElement | null,
) {
  if (!container) {
    return false;
  }

  return (
    event.target !== container &&
    event.target instanceof Node &&
    !container.contains(event.target)
  );
}

export function offsetYToMinutes(
  offsetY: number,
  zoomLevel: number,
  startHour: number,
) {
  const hiddenHoursSize = startHour * 60 * zoomLevel;

  return (offsetY + hiddenHoursSize) / zoomLevel;
}

export function getDarkModeFlag() {
  return activeDocument.body.hasClass("theme-dark");
}

export function getPointerOffsetY(
  el: HTMLElement,
  event: MouseEvent | TouchEvent,
) {
  return getClientOffsetY(el, getIsomorphicClientY(event));
}

export function getClientOffsetY(el: HTMLElement, clientY: number) {
  const viewportToElOffsetY = el.getBoundingClientRect().top;

  return clientY - viewportToElOffsetY;
}

export function getScrollZones(
  event: MouseEvent | TouchEvent,
  el: HTMLElement,
) {
  const pointerOffsetY = getPointerOffsetY(el, event);

  const isInTopScrollZone =
    (el.clientHeight / 100) * scrollOnHoverZoneHeightPercent >= pointerOffsetY;
  const isInBottomScrollZone =
    (el.clientHeight / 100) * (100 - scrollOnHoverZoneHeightPercent) <=
    pointerOffsetY;

  return { isInBottomScrollZone, isInTopScrollZone };
}

type ScrollDirection = "up" | "down";
type ScrollProps = { el: HTMLElement; direction: ScrollDirection };

export const autoScrollPointerMoveEventName =
  "day-planner-auto-scroll-pointer-move";

export interface ClientCoordinates {
  clientX: number;
  clientY: number;
}

export interface AutoScrollPointerMove {
  clientY: number;
  scrollDeltaY: number;
}

export function dispatchAutoScrollPointerMove(
  scroller: HTMLElement,
  coordinates: ClientCoordinates,
  scrollDeltaY: number,
) {
  const { clientX, clientY } = coordinates;
  const hitTarget = scroller.ownerDocument.elementFromPoint(clientX, clientY);

  if (!hitTarget || !scroller.contains(hitTarget)) {
    return;
  }

  const customEventConstructor =
    scroller.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;

  hitTarget.dispatchEvent(
    new customEventConstructor(autoScrollPointerMoveEventName, {
      bubbles: true,
      detail: { clientY, scrollDeltaY },
    }),
  );
}

export function listenForAutoScrollPointerMove(
  node: HTMLElement,
  listener: (move: AutoScrollPointerMove) => void,
) {
  const handleAutoScrollPointerMove = (event: Event) => {
    const { clientY, scrollDeltaY } = (
      event as CustomEvent<Partial<AutoScrollPointerMove>>
    ).detail ?? { clientY: undefined, scrollDeltaY: undefined };

    if (typeof clientY !== "number" || typeof scrollDeltaY !== "number") {
      return;
    }

    listener({ clientY, scrollDeltaY });
  };

  node.addEventListener(
    autoScrollPointerMoveEventName,
    handleAutoScrollPointerMove,
  );

  return {
    destroy() {
      node.removeEventListener(
        autoScrollPointerMoveEventName,
        handleAutoScrollPointerMove,
      );
    },
  };
}

export function createAutoScroll(
  onScrollFrame?: (scroller: HTMLElement, scrollDeltaY: number) => void,
) {
  let currentScroll: ScrollProps | undefined;
  let framePending = false;

  function stopScroll() {
    currentScroll = undefined;
  }

  function scroll() {
    if (framePending) {
      return;
    }

    framePending = true;

    window.requestAnimationFrame(() => {
      framePending = false;

      if (!currentScroll) {
        return;
      }

      const { el, direction } = currentScroll;
      const previousScrollTop = el.scrollTop;

      if (direction === "up") {
        el.scrollTop -= scrollSpeedPixelsPerAnimationFrame;
      } else if (direction === "down") {
        el.scrollTop += scrollSpeedPixelsPerAnimationFrame;
      }

      const scrollDeltaY = el.scrollTop - previousScrollTop;

      if (scrollDeltaY !== 0) {
        onScrollFrame?.(el, scrollDeltaY);
      }

      scroll();
    });
  }

  function startScroll(props: ScrollProps) {
    currentScroll = props;
    scroll();
  }

  return { startScroll, stopScroll };
}

export const checkboxInRenderedMarkdownSelector =
  '[data-task] input[type="checkbox"]';

export function addLineDataToCheckboxes(
  el: HTMLElement,
  taskLines: Array<number | undefined>,
) {
  if (!taskLines) {
    return;
  }

  el.querySelectorAll(checkboxInRenderedMarkdownSelector).forEach(
    (checkbox, i) => {
      const taskLine = taskLines[i];

      if (!isHTMLElement(checkbox)) {
        return;
      }
      if (taskLine === undefined) {
        (checkbox as HTMLInputElement).disabled = true;
        delete checkbox.dataset.line;
        return;
      }

      (checkbox as HTMLInputElement).disabled = false;
      checkbox.dataset.line = String(taskLine);
    },
  );
}

export async function readCheckboxLineData(
  event: Event,
  checkFn: (line: number) => Promise<void>,
) {
  if (!isHTMLElement(event.target)) {
    return;
  }

  const line = event.target.dataset.line;

  if (!line) {
    return;
  }

  event.stopPropagation();

  const input = event.target as HTMLInputElement;
  const checked = input.checked;
  try {
    await checkFn(Number(line));
  } catch (error) {
    if (input.checked === checked) input.checked = !checked;
    new Notice(
      error instanceof Error ? error.message : "Could not save this checkbox.",
    );
  }
}
function stopPropagationForElWithLineData(event: Event) {
  if (isHTMLElement(event.target) && event.target.dataset.line) {
    event.stopPropagation();
  }
}

export function createRenderMarkdownAttachment({
  renderMarkdown,
  markdown,
  sourcePath,
  taskLines,
  onCheckboxLineClick,
}: {
  renderMarkdown: (
    el: HTMLElement,
    markdown: string,
    sourcePath: string,
  ) => () => void;
  markdown: string;
  sourcePath: string;
  taskLines: Array<number | undefined>;
  onCheckboxLineClick?: (line: number) => Promise<void>;
}) {
  return (el: HTMLElement) => {
    const destroyMarkdown = renderMarkdown(el, markdown, sourcePath);

    addLineDataToCheckboxes(el, taskLines);

    const offClick = on(el, "click", (event: MouseEvent) => {
      if (onCheckboxLineClick) {
        readCheckboxLineData(event, onCheckboxLineClick);
      }
    });
    const offPointerDown = on(
      el,
      "pointerdown",
      stopPropagationForElWithLineData,
    );
    const offPointerUp = on(el, "pointerup", stopPropagationForElWithLineData);
    const offMouseDown = on(el, "mousedown", stopPropagationForElWithLineData);
    const offMouseUp = on(el, "mouseup", stopPropagationForElWithLineData);
    const offTouchStart = on(
      el,
      "touchstart",
      stopPropagationForElWithLineData,
    );
    const offTouchEnd = on(el, "touchend", stopPropagationForElWithLineData);

    return () => {
      destroyMarkdown();
      offClick();
      offPointerDown();
      offPointerUp();
      offMouseDown();
      offMouseUp();
      offTouchStart();
      offTouchEnd();
    };
  };
}

type MarkdownRenderOptions = Parameters<
  typeof createRenderMarkdownAttachment
>[0];

/** Keep painted content until its replacement is ready; line-number handoffs need no render. */
export function renderMarkdownAction(
  el: HTMLElement,
  initial: MarkdownRenderOptions,
) {
  let latest = initial;
  let generation = 0;
  let painted: MarkdownRenderOptions | undefined;
  let pending: MarkdownRenderOptions | undefined;
  let destroyPainted: (() => void) | undefined;
  let destroyPending: (() => void) | undefined;
  const same = (
    a: MarkdownRenderOptions | undefined,
    b: MarkdownRenderOptions,
  ) =>
    a?.markdown === b.markdown &&
    a.sourcePath === b.sourcePath &&
    a.renderMarkdown === b.renderMarkdown;
  const click = (event: MouseEvent) => {
    if (!pending && latest.onCheckboxLineClick)
      void readCheckboxLineData(event, latest.onCheckboxLineClick);
  };
  const off = [
    on(el, "click", click),
    ...[
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
    ].map((name) => on(el, name, stopPropagationForElWithLineData)),
  ];
  const update = (options: MarkdownRenderOptions) => {
    latest = options;
    if (same(painted, options)) {
      generation++;
      destroyPending?.();
      destroyPending = undefined;
      pending = undefined;
      addLineDataToCheckboxes(el, latest.taskLines);
      return;
    }
    if (same(pending, options)) return;
    const token = ++generation;
    destroyPending?.();
    pending = options;
    addLineDataToCheckboxes(el, []);
    const stage = el.ownerDocument.createElement("div");
    stage.className = "planner-markdown-stage";
    const dispose = options.renderMarkdown(
      stage,
      options.markdown,
      options.sourcePath,
    ) as (() => void) & { ready?: Promise<void> };
    destroyPending = dispose;
    const commit = () => {
      if (generation !== token) return;
      const previous = destroyPainted;
      el.replaceChildren(stage);
      painted = options;
      pending = undefined;
      destroyPainted = dispose;
      destroyPending = undefined;
      previous?.();
      addLineDataToCheckboxes(el, latest.taskLines);
    };
    if (dispose.ready)
      void dispose.ready.then(commit, () => {
        if (generation === token) {
          dispose();
          destroyPending = undefined;
          pending = undefined;
        }
      });
    else commit();
  };
  update(initial);
  return {
    update,
    destroy() {
      generation++;
      destroyPending?.();
      destroyPainted?.();
      off.forEach((remove) => remove());
    },
  };
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
