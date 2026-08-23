import { SignIn } from "@clerk/nextjs";
import { isClerkConfigured } from "@/lib/env";

export default function SignInPage() {
  if (!isClerkConfigured) {
    return (
      <main style={{ padding: "var(--dc-space-6)" }}>
        <p>
          Sign-in is scaffolded but disabled: no Clerk keys are configured in this environment. See{" "}
          <code>.env.example</code>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ display: "flex", justifyContent: "center", padding: "var(--dc-space-6)" }}>
      <SignIn />
    </main>
  );
}
