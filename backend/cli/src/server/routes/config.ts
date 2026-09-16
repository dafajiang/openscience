import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "@synsci/util/lazy"

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenScience configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Config.redact(await Config.get()))
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenScience configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        // Validated above, but written as sent: the schema's parsed form
        // expands scalars and fills defaults that must not land in the file.
        c.req.valid("json")
        const config = (await c.req.json()) as Config.Info
        const next = Config.restore(config, await Config.get())
        await Config.update(next)
        return c.json(Config.redact(next))
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        // Same payload as GET /provider: ids, models and variants are all the
        // browser needs, so keys and loader options stay in the process.
        return c.json({
          providers: Object.values(providers).map(Provider.redact),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .put(
      "/provider/:id",
      describeRoute({
        summary: "Persist config provider",
        description: "Persistently add or update a provider block in config.",
        operationId: "config.provider.set",
        responses: {
          200: {
            description: "Provider persisted successfully",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator(
        "json",
        z.object({
          provider: Config.Provider,
          scope: Config.Scope.optional(),
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const { provider, scope = "global" } = c.req.valid("json")
        await Config.setProvider(id, provider, scope)
        // patchConfigPath disposes Instances but Provider keeps a module-level
        // state cache that only invalidate()/directory-switch clears.
        Provider.invalidate()
        return c.json({ success: true as const })
      },
    )
    .delete(
      "/provider/:id",
      describeRoute({
        summary: "Remove config provider",
        description: "Remove a provider block from config.",
        operationId: "config.provider.remove",
        responses: {
          200: {
            description: "Provider removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.literal(true) })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", z.object({ scope: Config.Scope.optional() })),
      async (c) => {
        const { id } = c.req.valid("param")
        const { scope = "global" } = c.req.valid("query")
        await Config.removeProvider(id, scope)
        Provider.invalidate()
        return c.json({ success: true as const })
      },
    )
    .patch(
      "/enabled-providers",
      describeRoute({
        summary: "Amend enabled_providers whitelist",
        description:
          "Add/remove provider ids in the enabled_providers whitelist. No-op when the config has no whitelist.",
        operationId: "config.enabledProviders.patch",
        responses: {
          200: {
            description: "Resulting whitelist (null when no whitelist is configured)",
            content: {
              "application/json": {
                schema: resolver(z.object({ enabled_providers: z.string().array().nullable() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          add: z.string().array().optional(),
          remove: z.string().array().optional(),
          scope: Config.Scope.optional(),
        }),
      ),
      async (c) => {
        const { add = [], remove = [], scope = "global" } = c.req.valid("json")
        const current = scope === "global" ? await Config.getGlobal() : await Config.get()
        const list = current.enabled_providers
        if (!list) return c.json({ enabled_providers: null })
        const next = [...new Set([...list.filter((x) => !remove.includes(x)), ...add])]
        await Config.setEnabledProviders(next, scope)
        Provider.invalidate()
        return c.json({ enabled_providers: next })
      },
    ),
)
