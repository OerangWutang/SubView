import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitInterceptor } from "./interceptor";

vi.mock("./contextHeuristics", () => ({
  isLikelyCommitTarget: vi.fn(() => true)
}));

describe("CommitInterceptor - SPA Replay Resilience", () => {
  let interceptor: CommitInterceptor;
  let onInterceptMock: ReturnType<typeof vi.fn>;
  let form: HTMLFormElement;
  let button: HTMLButtonElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <form id="checkout-form">
        <button type="submit" id="submit-btn">Start Free Trial</button>
      </form>
    `;

    form = document.getElementById("checkout-form") as HTMLFormElement;
    button = document.getElementById("submit-btn") as HTMLButtonElement;

    form.requestSubmit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);

    onInterceptMock = vi.fn();
    interceptor = new CommitInterceptor(onInterceptMock);
    interceptor.start();

    interceptor.arm({
      confidence: 0.9,
      kind: "trial",
      evidence: [],
      detectedAtUrl: "http://localhost"
    });
  });

  afterEach(() => {
    interceptor.stop();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("Scenario 1: Standard replay (element still connected)", () => {
    button.click();

    expect(onInterceptMock).toHaveBeenCalledOnce();

    const resumed = interceptor.continueBlockedFormSubmission();

    expect(resumed).toBe(true);
  });

  it("Scenario 2: Detached click -> Fallback to Parent Form", () => {
    button.click();

    button.remove();
    expect(button.isConnected).toBe(false);

    const resumed = interceptor.continueBlockedFormSubmission();

    expect(resumed).toBe(true);
    expect(form.requestSubmit).toHaveBeenCalledOnce();
  });

  it("Scenario 3: Complete Detachment (Failed Replay)", () => {
    button.click();

    form.remove();
    expect(form.isConnected).toBe(false);
    expect(button.isConnected).toBe(false);

    const resumed = interceptor.continueBlockedFormSubmission();

    expect(resumed).toBe(false);
    expect(form.requestSubmit).not.toHaveBeenCalled();
    expect(HTMLFormElement.prototype.submit).not.toHaveBeenCalled();
  });

  it("Scenario 4: SPA re-render - fallback selector finds new element", () => {
    button.click();

    // Simulate SPA re-render: old form removed, new identical structure injected
    form.remove();
    expect(button.isConnected).toBe(false);

    const newForm = document.createElement("form");
    newForm.id = "checkout-form";
    const newButton = document.createElement("button");
    newButton.type = "submit";
    newButton.id = "submit-btn";
    newButton.textContent = "Start Free Trial";
    const newButtonClickSpy = vi.spyOn(newButton, "click");
    newForm.appendChild(newButton);
    document.body.appendChild(newForm);

    const resumed = interceptor.continueBlockedFormSubmission();

    expect(resumed).toBe(true);
    expect(newButtonClickSpy).toHaveBeenCalledOnce();
  });
});
