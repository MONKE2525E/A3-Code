import { describe, expect, it, vi } from "vite-plus/test";

import { completeEmailCodeSignIn } from "./emailCodeSignIn";

type SignIn = Parameters<typeof completeEmailCodeSignIn>[0];

function fixture(status: SignIn["status"] = "complete") {
  const verifyCode = vi.fn<SignIn["emailCode"]["verifyCode"]>(async () => ({ error: null }));
  const finalize = vi.fn<SignIn["finalize"]>(async () => ({ error: null }));
  const signIn = { status, emailCode: { verifyCode }, finalize } satisfies SignIn;
  return { signIn, verifyCode, finalize };
}

describe("Connect email sign-in", () => {
  it("activates the verified account session", async () => {
    const { signIn, verifyCode, finalize } = fixture("needs_first_factor");
    verifyCode.mockImplementation(async () => {
      signIn.status = "complete";
      return { error: null };
    });
    await completeEmailCodeSignIn(signIn, " 123456 ");
    expect(verifyCode).toHaveBeenCalledWith({ code: "123456" });
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("never activates an account when its verification code is rejected", async () => {
    const { signIn, verifyCode, finalize } = fixture();
    const error = Object.assign(new Error("Code expired"), {
      clerkError: true as const,
      code: "expired",
      longMessage: undefined,
      docsUrl: undefined,
      cause: undefined,
    });
    verifyCode.mockResolvedValue({ error });
    await expect(completeEmailCodeSignIn(signIn, "123456")).rejects.toBe(error);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not claim a session when additional account verification is required", async () => {
    const { signIn, finalize } = fixture("needs_second_factor");
    await expect(completeEmailCodeSignIn(signIn, "123456")).rejects.toThrow(
      "additional verification",
    );
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reports a session activation failure", async () => {
    const { signIn, finalize } = fixture();
    finalize.mockRejectedValue(new Error("Connection lost"));
    await expect(completeEmailCodeSignIn(signIn, "123456")).rejects.toThrow("Connection lost");
  });
});
