import type { useSignIn } from "@clerk/expo";

type SignIn = NonNullable<ReturnType<typeof useSignIn>["signIn"]>;
type EmailCodeSignIn = Pick<SignIn, "status" | "finalize"> & {
  readonly emailCode: Pick<SignIn["emailCode"], "verifyCode">;
};

export async function completeEmailCodeSignIn(signIn: EmailCodeSignIn, code: string) {
  const verification = await signIn.emailCode.verifyCode({ code: code.trim() });
  if (verification.error) throw verification.error;
  if (signIn.status !== "complete") {
    throw new Error(
      "This account requires additional verification that this Android sign-in flow does not support yet.",
    );
  }
  const activation = await signIn.finalize();
  if (activation.error) throw activation.error;
}
