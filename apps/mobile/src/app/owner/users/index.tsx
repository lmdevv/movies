/**
 * I08 · Users & Invites: the household's accounts with their roles, the invites still waiting to
 * be used, and Invite Someone. Each account opens its page (I10); a pending invite can be revoked.
 */
import type { Invite } from "@movies/contracts/models/account";
import { useCommand, useCommandQuery } from "@movies/sdk/react";
import { router } from "expo-router";
import { Link, Plus, User } from "lucide-react-native";
import { Alert } from "react-native";

import { OwnerScreen, QueryView, SectionHeading, showActions } from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { describeFailure } from "@/lib/failure";
import { householdOf, openInvites, userDetail } from "@/lib/household";

const invite = () => router.push("/owner/users/invite");

function PendingInvite({ invite: pending }: { readonly invite: Invite }) {
  const revoke = useCommand("invites.revoke");
  const label = pending.email ?? "Invite Link";

  return (
    <ListRow
      icon={Link}
      title={label}
      detail="Pending"
      onPress={() =>
        showActions(label, [
          {
            label: "Revoke Invite",
            destructive: true,
            onPress: () => {
              revoke({ inviteId: pending.id }).catch((cause: unknown) => {
                Alert.alert("Couldn’t Revoke Invite", describeFailure(cause));
              });
            },
          },
        ])
      }
    />
  );
}

export default function UsersAndInvites() {
  const users = useCommandQuery("users.list", {});
  const invites = useCommandQuery("invites.list", {});
  const pending = invites.status === "success" ? openInvites(invites.data) : [];

  return (
    <OwnerScreen
      title="Users & Invites"
      trailing={<IconButton icon={Plus} label="Invite Someone" onPress={invite} />}
    >
      <QueryView query={users}>
        {(list) =>
          householdOf(list).map((user) => (
            <ListRow
              key={user.id}
              icon={User}
              title={user.name}
              detail={userDetail(user)}
              onPress={() =>
                router.push({ pathname: "/owner/users/[userId]", params: { userId: user.id } })
              }
            />
          ))
        }
      </QueryView>
      {pending.length === 0 ? null : (
        <>
          <SectionHeading>Pending Invites</SectionHeading>
          {pending.map((each) => (
            <PendingInvite key={each.id} invite={each} />
          ))}
        </>
      )}
      <Button label="Invite Someone" icon={Plus} onPress={invite} />
    </OwnerScreen>
  );
}
