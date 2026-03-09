import { SCAN_DEBOUNCE_MS, SCAN_MAX_SNIPPETS, SCAN_TEXT_CHAR_LIMIT } from "../shared/constants";
import type { TextCandidate } from "./detector";

type ObserverCallback = (candidates: TextCandidate[]) => void;

function isIgnoredByAncestry(node: Node): boolean {
  if (!(node instanceof Element) && !(node.parentElement instanceof Element)) {
    return false;
  }

  const element = node instanceof Element ? node : node.parentElement;
  if (!element) {
    return false;
  }

  const blocked = element.closest("script, style, noscript, [hidden], [aria-hidden='true']");
  return Boolean(blocked);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collectTextCandidatesFromNode(node: Node, budget: { chars: number; snippets: number }): TextCandidate[] {
  const output: TextCandidate[] = [];

  const walkerRoot = node instanceof Text ? node.parentNode : node;
  if (!walkerRoot) {
    return output;
  }

  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.currentNode;

  while (current) {
    if (budget.snippets >= SCAN_MAX_SNIPPETS || budget.chars >= SCAN_TEXT_CHAR_LIMIT) {
      break;
    }

    if (current instanceof Text) {
      const parent = current.parentElement;
      if (!isIgnoredByAncestry(current) && parent) {
        const text = normalizeText(current.textContent ?? "");
        if (text.length > 0) {
          const clipped = text.slice(0, 300);
          budget.snippets += 1;
          budget.chars += clipped.length;
          output.push({ text: clipped, element: new WeakRef(parent) });
        }
      }
    }

    current = walker.nextNode();
  }

  return output;
}

export class IncrementalTextObserver {
  private observer: MutationObserver | null = null;
  private queue = new Set<Node>();
  private timer: number | null = null;

  constructor(private readonly onCandidates: ObserverCallback) {}

  start(): void {
    if (!document.body || this.observer) {
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target) {
          this.queue.add(mutation.target);
        }

        mutation.addedNodes.forEach((node) => {
          this.queue.add(node);
        });
      }
      this.schedule();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    this.forceScan(document.body);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.queue.clear();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  forceScan(root: Node = document.body): void {
    if (!root) {
      return;
    }
    this.queue.clear();
    this.queue.add(root);
    this.flushQueue();
  }

  private schedule(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }

    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flushQueue();
    }, SCAN_DEBOUNCE_MS);
  }

  private flushQueue(): void {
    if (this.queue.size === 0) {
      return;
    }

    const start = performance.now();
    const budget = { chars: 0, snippets: 0 };
    const candidates: TextCandidate[] = [];

    const rootNodes = new Set<Node>();
    for (const node of this.queue) {
      let isRedundant = false;
      let parent = node.parentNode;
      while (parent) {
        if (this.queue.has(parent)) {
          isRedundant = true;
          break;
        }
        parent = parent.parentNode;
      }

      if (!isRedundant) {
        rootNodes.add(node);
      }
    }

    for (const node of rootNodes) {
      if (budget.snippets >= SCAN_MAX_SNIPPETS || budget.chars >= SCAN_TEXT_CHAR_LIMIT) {
        break;
      }

      const chunk = collectTextCandidatesFromNode(node, budget);
      candidates.push(...chunk);
    }

    this.queue.clear();
    const elapsed = performance.now() - start;

    if (elapsed > 40) {
      console.debug(
        `[SubView] Heavy DOM scan: ${elapsed.toFixed(1)}ms for ${candidates.length} snippets (roots: ${rootNodes.size})`
      );
    }

    if (candidates.length > 0) {
      this.onCandidates(candidates);
    }
  }
}
