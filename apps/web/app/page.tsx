import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/server";

export default async function HomePage() {
  const auth = await getAuthContext();
  redirect(auth ? "/dashboard" : "/login");
}
