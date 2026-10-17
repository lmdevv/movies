/**
 * B03/B09 · Edit Profile and B11 · Create Profile: the avatar with its pencil, the name, Kids
 * Profile, Profile PIN (editing only), and Maximum Rating. The check saves; Create Profile also
 * has its button under the form. Deleting asks first on its own sheet.
 */
import { router } from "expo-router";
import { Check, Clapperboard, Lock, Pencil, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { ActionSheetIOS, View } from "react-native";

import { useProfileEditor } from "@/components/profile-editor";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { Toggle } from "@/components/ui/toggle";
import { describeFailure } from "@/lib/failure";
import { canSave, pinDetail, ratingLabel, willHavePin, withKids } from "@/lib/profile-draft";
import { useAccountProfiles } from "@/session/account-profiles";

export default function ProfileForm() {
  const { profile, draft, change, save } = useProfileEditor();
  const profiles = useAccountProfiles();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const creating = profile === null;
  const ready = canSave(draft) && !saving;
  const hasPin = willHavePin(profile?.hasPin ?? false, draft.pin);

  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);

    try {
      await save();
      router.back();
    } catch (cause) {
      setError(describeFailure(cause));
      setSaving(false);
    }
  };

  const editPin = () => {
    if (!hasPin) {
      router.push("./pin");

      return;
    }

    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Change PIN", "Turn Off PIN", "Cancel"],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
      (index) => {
        if (index === 0) router.push("./pin");
        else if (index === 1) change((current) => ({ ...current, pin: { kind: "clear" } }));
      },
    );
  };

  return (
    <Screen
      scroll
      header={
        <NavHeader
          title={creating ? "Create Profile" : "Edit Profile"}
          trailing={
            <IconButton
              icon={Check}
              label={creating ? "Create Profile" : "Save"}
              disabled={!ready}
              className={ready ? "" : "opacity-40"}
              onPress={() => void submit()}
            />
          }
        />
      }
    >
      <View className="flex-row items-end justify-center gap-2 py-6">
        <ProfileAvatar
          profile={{
            name: draft.name === "" ? "?" : draft.name,
            kids: draft.kids,
            avatar: draft.avatar,
          }}
          size="editor"
        />
        <IconButton icon={Pencil} label="Choose Avatar" onPress={() => router.push("./avatar")} />
      </View>
      <TextField
        label="Name"
        value={draft.name}
        onChangeText={(name) => change((current) => ({ ...current, name }))}
        error={error}
        autoCapitalize="words"
        textContentType="nickname"
        maxLength={80}
        returnKeyType="done"
        autoFocus={creating}
        onSubmitEditing={() => void submit()}
      />
      <ListRow
        icon={ShieldCheck}
        title="Kids Profile"
        trailing={
          <Toggle
            label="Kids Profile"
            value={draft.kids}
            onValueChange={(kids) => change((current) => withKids(current, kids))}
          />
        }
      />
      {creating ? null : (
        <ListRow
          icon={Lock}
          title="Profile PIN"
          detail={pinDetail(profile.hasPin, draft.pin)}
          onPress={editPin}
        />
      )}
      <ListRow
        icon={Clapperboard}
        title="Maximum Rating"
        detail={ratingLabel(draft.maxAgeRating)}
        onPress={() => router.push("./rating")}
      />
      {creating ? (
        <Button
          label="Create Profile"
          busy={saving}
          disabled={!canSave(draft)}
          onPress={() => void submit()}
        />
      ) : profiles.length > 1 ? (
        <>
          <View className="h-6" />
          <Button
            label="Delete Profile"
            variant="plainDestructive"
            onPress={() =>
              router.push({
                pathname: "/delete-profile/[profileId]",
                params: { profileId: profile.id },
              })
            }
          />
        </>
      ) : null}
    </Screen>
  );
}
