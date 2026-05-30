import { getOrCreateUser } from "@/lib/get-or-create-user";
import { isAdmin } from "@/lib/auth";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await getOrCreateUser();
  return <SettingsClient isAdmin={isAdmin(user)} />;
}
