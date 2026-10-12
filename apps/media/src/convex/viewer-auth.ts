/**
 * Authorizes registry `media` commands: the caller sends its Convex auth token as a bearer token,
 * and this asks Convex who that is by calling `account.viewer` with it, then checks the command's
 * scope against the session's scopes. Convex checks the session row on every call, so a revoked
 * key or a signed-out session is refused at once. The token is used for that one call only.
 */
import { commands } from "@movies/contracts/commands";
import { Forbidden, Internal } from "@movies/contracts/errors";
import type { Viewer } from "@movies/contracts/models/account";
import type { CommandAccess } from "@movies/contracts/scopes";
import { ConvexTransport, ProtocolError } from "@movies/sdk/effect";
import type { CallError } from "@movies/sdk/effect";
import { Context, Effect, Layer, Redacted, Schema } from "effect";

/** Checks who a bearer token belongs to and what it may do. */
export interface Interface {
  /**
   * The viewer behind `bearer` when its session holds `access`. Fails with `Unauthenticated`
   * for a token Convex does not accept and `Forbidden` when the session lacks the scope.
   */
  readonly authorize: (
    bearer: Redacted.Redacted,
    access: CommandAccess,
  ) => Effect.Effect<Viewer, CallError>;
}

/** The viewer authorizer. */
export class Service extends Context.Service<Service, Interface>()("@movies/media/ViewerAuth") {}

const viewerCommand = commands["account.viewer"];

const decodeViewer = Schema.decodeUnknownEffect(viewerCommand.result);

/** Authorizes against the Convex deployment at `convexUrl`. */
export const layer = (convexUrl: string): Layer.Layer<Service> =>
  Layer.succeed(
    Service,
    Service.of({
      authorize: Effect.fn("ViewerAuth.authorize")(function* (bearer, access) {
        const viewer = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(ConvexTransport.layerHttp(convexUrl));
            const transport = Context.get(context, ConvexTransport.ConvexTransport);

            yield* transport.setAuth(() => Promise.resolve(Redacted.value(bearer)));

            const raw = yield* transport.call("query", viewerCommand.function, {});

            return yield* decodeViewer(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ProtocolError({
                    operation: "account.viewer",
                    message: "Protocol error in account.viewer: unexpected viewer",
                    cause,
                  }),
              ),
            );
          }),
        );

        const allowed =
          access === "public" ||
          access === "authenticated" ||
          viewer.scopes.some((scope) => scope === access);

        if (!allowed) {
          return yield* new Forbidden({ message: `This session lacks the ${access} scope` });
        }

        return viewer;
      }),
    }),
  );

/** Standalone mode has no accounts, so every command that needs one is refused. */
export const layerStandalone: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    authorize: () =>
      Effect.fail(new Internal({ message: "This media service runs without Convex" })),
  }),
);
