import { redirect } from "next/navigation";
import { getCachedAuthContext } from "@/lib/auth/server";

export default async function HomePage() {
  const auth = await getCachedAuthContext();
  redirect(auth ? "/dashboard" : "/login");
}
