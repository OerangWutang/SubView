import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSubscriptionContext } from "./detector";

describe("detectSubscriptionContext", () => {
  it("does not load checkout context when no regex hit is found", () => {
    const contextLoader = vi.fn(() => ({ score: 1, evidence: ["context:payment_fields"] }));

    const detection = detectSubscriptionContext({
      candidates: [{ text: "Welcome to our about page" }],
      url: "https://example.com/about",
      contextLoader
    });

    expect(detection).toBeNull();
    expect(contextLoader).not.toHaveBeenCalled();
  });

  it("loads checkout context only after a text hit and merges context evidence", () => {
    const contextLoader = vi.fn(() => ({ score: 0.8, evidence: ["context:commit_button"] }));

    const detection = detectSubscriptionContext({
      candidates: [{ text: "Start trial now and then USD 9.99 per month" }],
      url: "https://example.com/checkout",
      contextLoader
    });

    expect(detection).not.toBeNull();
    expect(contextLoader).toHaveBeenCalledOnce();
    expect(detection?.evidence).toContain("context:commit_button");
    expect(detection?.priceAfterTrial).toBe("USD 9.99 per month");
    expect(detection?.renewalPeriod).toBe("month");
  });

  it("extracts newly supported number words for trial days", () => {
    const detection = detectSubscriptionContext({
      candidates: [{ text: "Enjoy a twenty day free trial" }],
      url: "https://example.com/trial",
      contextLoader: () => ({ score: 0, evidence: [] })
    });

    expect(detection).not.toBeNull();
    expect(detection?.trialDays).toBe(20);
  });

  it("normalizes week and month trial lengths to day counts", () => {
    const weekDetection = detectSubscriptionContext({
      candidates: [{ text: "Get 2 weeks free trial" }],
      url: "https://example.com/plan",
      contextLoader: () => ({ score: 0, evidence: [] })
    });

    const monthDetection = detectSubscriptionContext({
      candidates: [{ text: "Start a 2 months free trial" }],
      url: "https://example.com/plan",
      contextLoader: () => ({ score: 0, evidence: [] })
    });

    expect(weekDetection?.trialDays).toBe(14);
    expect(monthDetection?.trialDays).toBe(60);
  });

  describe("international currency format (currency code/symbol after digit)", () => {
    it("detects renewal regex and extracts price when currency code follows digit (e.g. 9.99 USD)", () => {
      const detection = detectSubscriptionContext({
        candidates: [{ text: "Start your free trial, then 9.99 USD per month" }],
        url: "https://example.com/checkout",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).not.toBeNull();
      expect(detection?.priceAfterTrial).toBe("9.99 USD per month");
    });

    it("detects renewal regex and extracts price when currency symbol follows digit (e.g. 9.99€)", () => {
      const detection = detectSubscriptionContext({
        candidates: [{ text: "Free 30-day trial, then 9.99€ per month" }],
        url: "https://example.com/checkout",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).not.toBeNull();
      expect(detection?.priceAfterTrial).toBe("9.99€ per month");
    });

    it("detects renewal regex when currency symbol precedes digit (existing format unchanged)", () => {
      const detection = detectSubscriptionContext({
        candidates: [{ text: "Free trial period, then $9.99 per month" }],
        url: "https://example.com/checkout",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).not.toBeNull();
      expect(detection?.priceAfterTrial).toBe("$9.99 per month");
    });
  });

  describe("CSS dark pattern detection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      document.body.innerHTML = "";
    });

    function makeVisibleElement(styles: Partial<CSSStyleDeclaration>): WeakRef<Element> {
      const el = document.createElement("span");
      document.body.appendChild(el);
      // Override getClientRects to simulate a laid-out element
      vi.spyOn(el, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        display: "inline",
        visibility: "visible",
        opacity: "1",
        fontSize: "14px",
        color: "rgb(0, 0, 0)",
        ...styles
      } as CSSStyleDeclaration);
      return new WeakRef(el);
    }

    it("filters out candidate whose computed fontSize is 0px", () => {
      const element = makeVisibleElement({ fontSize: "0px" });

      const detection = detectSubscriptionContext({
        candidates: [{ text: "Start trial now", element }],
        url: "https://example.com/trial",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).toBeNull();
    });

    it("filters out candidate whose computed color is transparent", () => {
      const element = makeVisibleElement({ color: "transparent" });

      const detection = detectSubscriptionContext({
        candidates: [{ text: "Start trial now", element }],
        url: "https://example.com/trial",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).toBeNull();
    });

    it("filters out candidate whose computed color is rgba(0, 0, 0, 0)", () => {
      const element = makeVisibleElement({ color: "rgba(0, 0, 0, 0)" });

      const detection = detectSubscriptionContext({
        candidates: [{ text: "Start trial now", element }],
        url: "https://example.com/trial",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).toBeNull();
    });

    it("does not filter out a normally styled candidate", () => {
      const element = makeVisibleElement({});

      const detection = detectSubscriptionContext({
        candidates: [{ text: "Start trial now", element }],
        url: "https://example.com/trial",
        contextLoader: () => ({ score: 0, evidence: [] })
      });

      expect(detection).not.toBeNull();
    });
  });
});
