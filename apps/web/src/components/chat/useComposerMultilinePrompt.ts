import { useLayoutEffect, useState } from "react";
import { observeResize } from "../../lib/observeResize";

function collectTextNodes(node: Node, out: Text[] = []): Text[] {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
    else collectTextNodes(child, out);
  }
  return out;
}

/**
 * Width of the text the editor paints, taken from its text runs. The block
 * boxes around those runs span the full row, so measuring the block would make
 * a one-word draft look as wide as the editor.
 */
function measureInlineTextWidth(editor: HTMLElement): number {
  const range = document.createRange();
  let left = Infinity;
  let right = -Infinity;
  for (const text of collectTextNodes(editor)) {
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
  }
  return right > left ? right - left : 0;
}

/**
 * `reservedWidth` is the inset a compact row takes from the text line on the
 * right. That row wraps at exactly `expandedWidth - reservedWidth`, so the
 * one-pixel slack the expanded check allows would leave a band where the
 * compact row wraps but reads as one line, and the two layouts would flip.
 */
export function measureComposerMultilinePrompt(
  body: HTMLElement,
  reservedWidth = 0,
): boolean | null {
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!editor || editor.clientWidth === 0) return null;

  const bodyStyle = getComputedStyle(body);
  const expandedWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  const range = document.createRange();
  range.selectNodeContents(editor);
  // Height still comes from the block so that paragraphs and soft wraps count
  // as lines, including empty ones.
  const bounds = range.getBoundingClientRect();
  const textWidth = measureInlineTextWidth(editor);
  const slack = reservedWidth > 0 ? 0 : 1;

  // Measure content, not the editor's minimum height. While resting, the
  // prompt is unwrapped: compare its text width with the expanded row so that
  // moving the actions inline cannot make collapse and expansion oscillate.
  return bounds.height > lineHeight + 1 || textWidth > expandedWidth - reservedWidth + slack;
}

export function useComposerMultilinePrompt(body: HTMLElement | null, reservedWidth = 0): boolean {
  const [isMultiline, setIsMultiline] = useState(false);

  useLayoutEffect(() => {
    if (!body) return;
    const measure = () => {
      const next = measureComposerMultilinePrompt(body, reservedWidth);
      if (next !== null) setIsMultiline(next);
    };
    measure();
    const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    const stopObserving = observeResize(editor ? [body, editor] : body, measure);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, characterData: true, subtree: true });
    return () => {
      stopObserving();
      mutationObserver.disconnect();
    };
  }, [body, reservedWidth]);

  return isMultiline;
}
