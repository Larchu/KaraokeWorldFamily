import { useCallback, useEffect, useState } from "react";
import { apiJson, setSingerToken } from "@/lib/api";

export interface AuthUser {
  id: string;
  display_name: string;
  card_code: string;
}

export function useAuthUser() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await apiJson<{ user: AuthUser | null }>("/api/auth/session");
      setUser(data.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await apiJson("/api/auth/logout", { method: "POST" }).catch(() => {});
    setSingerToken(null);
    setUser(null);
  }, []);

  return { user, ready, refresh, signOut };
}
