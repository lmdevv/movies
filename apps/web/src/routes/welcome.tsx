import { useAuth, useCommandQuery } from "@movies/sdk/react";
import { Button } from "@movies/ui/components/button";
import { FieldError, TextField } from "@movies/ui/components/text-field";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthPage, PageTitle, PasswordField, SetupSteps } from "@/components/auth/auth-page";
import { MIN_PASSWORD_LENGTH, passwordHint } from "@/lib/password";
import { describeFailure } from "@/lib/failure";
import { BlankPage, Redirect } from "@/session/redirect";

export const Route = createFileRoute("/welcome")({
  head: () => ({ meta: [{ title: "Welcome · [movies]" }] }),
  component: WelcomePage,
});

/** First run, step 1: create the owner account. Once an owner exists this page moves on. */
function WelcomePage() {
  const { status } = useAuth();
  const setup = useCommandQuery("setup.status", {});
  const [submitted, setSubmitted] = useState(false);

  if (submitted) return <OwnerForm onCreated={() => undefined} />;

  if (status === "loading" || setup.status === "loading") return <BlankPage />;

  if (setup.status === "success" && setup.data.hasOwner) {
    if (status === "signedOut") return <Redirect href="/sign-in" />;

    return <Redirect href={setup.data.hasLibraries ? "/" : "/setup/library"} />;
  }

  return <OwnerForm onCreated={() => setSubmitted(true)} />;
}

function OwnerForm({ onCreated }: { readonly onCreated: () => void }) {
  const { signInWithPassword } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);

      return;
    }

    setPending(true);
    setError(null);

    try {
      await signInWithPassword({
        flow: "signUp",
        name: name.trim(),
        email: email.trim(),
        password,
      });
      onCreated();
      await navigate({ to: "/setup/library", replace: true });
    } catch (cause) {
      setError(describeFailure(cause));
      setPending(false);
    }
  };

  return (
    <AuthPage>
      <div className="flex flex-col gap-3">
        <SetupSteps step={1} label="Admin" />
        <PageTitle>Welcome to your own screening room.</PageTitle>
      </div>
      <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <TextField
            label="Your name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PasswordField
            label="Password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={passwordHint(password)}
          />
          {error === null ? null : <FieldError>{error}</FieldError>}
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          Create admin account
          <ArrowRightIcon strokeWidth={2} aria-hidden />
        </Button>
      </form>
    </AuthPage>
  );
}
