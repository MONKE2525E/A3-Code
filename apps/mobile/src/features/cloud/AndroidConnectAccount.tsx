import { useClerk, useSignIn } from "@clerk/expo";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { completeEmailCodeSignIn } from "./emailCodeSignIn";
import { T3ConnectProfilePage } from "./T3ConnectProfilePage";

// Custom APKs have their own package ID, which production social OAuth callbacks do not allow.
// Email verification keeps the official account and relay without changing the installed identity.
export function AndroidConnectAccount({ signedIn }: { readonly signedIn: boolean }) {
  const { signOut } = useClerk();
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  return (
    <SettingsScreen title="T3 Account">
      {signedIn ? (
        <>
          <View className="gap-3 px-5 py-4">
            <Button
              label="Sign out"
              loading={signingOut}
              onPress={() => {
                if (signingOut) return;
                setSigningOut(true);
                setError(null);
                void signOut().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "Could not sign out.");
                  setSigningOut(false);
                });
              }}
            />
            {error ? (
              <AppText accessibilityRole="alert" className="text-danger-foreground">
                {error}
              </AppText>
            ) : null}
          </View>
          <T3ConnectProfilePage />
        </>
      ) : (
        <EmailCodeForm />
      )}
    </SettingsScreen>
  );
}

function EmailCodeForm() {
  const { signIn } = useSignIn();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const submit = async () => {
    if (!signIn || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (codeSent) {
        await completeEmailCodeSignIn(signIn, code);
      } else {
        const result = await signIn.emailCode.sendCode({ emailAddress: email.trim() });
        if (result.error) throw result.error;
        setCodeSent(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-5 px-5 py-6">
      <AppText textRole="title">Sign in to T3 Connect</AppText>
      <AppText className="text-foreground-muted">
        {codeSent
          ? "Enter the verification code sent to your email."
          : "Use the email address for your existing T3 account to reach your computer and bots."}
      </AppText>
      <View className="gap-2">
        <AppText>{codeSent ? "Verification code" : "Email address"}</AppText>
        <AppTextInput
          key={codeSent ? "code" : "email"}
          accessibilityLabel={codeSent ? "Verification code" : "Email address"}
          value={codeSent ? code : email}
          onChangeText={codeSent ? setCode : setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={codeSent ? "one-time-code" : "email"}
          keyboardType={codeSent ? "number-pad" : "email-address"}
          editable={!busy}
          onSubmitEditing={() => void submit()}
        />
      </View>
      {error ? (
        <AppText accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </AppText>
      ) : null}
      <Button
        label={codeSent ? "Sign in" : "Send verification code"}
        tone="primary"
        fullWidth
        loading={busy}
        disabled={!signIn || !(codeSent ? code.trim() : email.trim())}
        onPress={() => void submit()}
      />
      {codeSent ? (
        <Button
          label="Use another email or request a new code"
          tone="text"
          disabled={busy}
          onPress={() => {
            setCodeSent(false);
            setCode("");
            setError(null);
          }}
        />
      ) : null}
    </ScrollView>
  );
}
