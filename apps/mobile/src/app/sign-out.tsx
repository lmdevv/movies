/** H15 · Sign Out: the sheet that confirms signing this iPhone out of the account. */
import { ConfirmSheet } from "@/components/settings/confirm-sheet";
import { useSignOut } from "@/session/viewer";

export default function SignOut() {
  const signOut = useSignOut();

  // Signing out changes the session phase, which takes the app back to Sign In.
  return (
    <ConfirmSheet
      title="Sign out of [movies]?"
      description="This iPhone will need to sign in again."
      action="Sign Out"
      onConfirm={signOut}
      closesItself
    />
  );
}
