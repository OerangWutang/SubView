import { describe, expect, it, vi } from "vitest";
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
});
