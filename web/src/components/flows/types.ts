import type { MeResponse, Role } from "../../sync/api";

// Props every flow screen receives from App.tsx's router. Screens fetch
// their own data via hooks; this is only identity + navigation.
export interface FlowScreenContext {
  role: Role;
  me: MeResponse | null;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
}
