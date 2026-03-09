import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitInterceptor } from "./interceptor";
import { isLikelyCommitTarget } from "./contextHeuristics";

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
});

describe("CommitInterceptor - Submit Event Interception", () => {
  let interceptor: CommitInterceptor;
  let onInterceptMock: ReturnType<typeof vi.fn>;
  let form: HTMLFormElement;
  let button: HTMLButtonElement;
  const isLikelyCommitTargetMock = isLikelyCommitTarget as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = `
      <form id="test-form">
        <button type="submit" id="submit-btn">Start Free Trial</button>
      </form>
    `;

    form = document.getElementById("test-form") as HTMLFormElement;
    button = document.getElementById("submit-btn") as HTMLButtonElement;
    form.requestSubmit = vi.fn();

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

  it("uses event.submitter when available for commit target check", () => {
    isLikelyCommitTargetMock.mockReturnValue(true);

    const submitEvent = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button });
    form.dispatchEvent(submitEvent);

    expect(isLikelyCommitTargetMock).toHaveBeenCalledWith(button, undefined);
    expect(onInterceptMock).toHaveBeenCalledOnce();
  });

  it("falls back to event.target when submitter is null", () => {
    isLikelyCommitTargetMock.mockReturnValue(true);

    const submitEvent = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: null });
    form.dispatchEvent(submitEvent);

    expect(isLikelyCommitTargetMock).toHaveBeenCalledWith(form, undefined);
    expect(onInterceptMock).toHaveBeenCalledOnce();
  });

  it("does not intercept when isLikelyCommitTarget returns false for the submitter", () => {
    isLikelyCommitTargetMock.mockReturnValue(false);

    const submitEvent = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button });
    form.dispatchEvent(submitEvent);

    expect(onInterceptMock).not.toHaveBeenCalled();
  });

  it("intercepts submit and stores form for replay", () => {
    isLikelyCommitTargetMock.mockReturnValue(true);
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);

    const submitEvent = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button });
    form.dispatchEvent(submitEvent);

    expect(onInterceptMock).toHaveBeenCalledOnce();

    const resumed = interceptor.continueBlockedFormSubmission();
    expect(resumed).toBe(true);
    expect(form.requestSubmit).toHaveBeenCalledOnce();
  });
});
