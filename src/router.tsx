import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { RootLayout, NotFoundComponent, ErrorComponent, queryClient } from "./routes/RootLayout";
import { GuestPage } from "./routes/GuestPage";
import { DjPage } from "./routes/DjPage";
import { StagePage } from "./routes/StagePage";
import { LeaderboardPage } from "./routes/LeaderboardPage";
import { AccountPage } from "./routes/AccountPage";
import { LikePage } from "./routes/LikePage";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): { q?: string } =>
    typeof s["q"] === "string" ? { q: s["q"] } : {},
  component: GuestPage,
});

const djRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dj",
  component: DjPage,
});

const stageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stage",
  component: StagePage,
});

const leaderboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rangliste",
  component: LeaderboardPage,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/konto",
  component: AccountPage,
});

const likeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/like/$requestId",
  component: LikePage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  djRoute,
  stageRoute,
  leaderboardRoute,
  accountRoute,
  likeRoute,
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
