import path from "path"
import fs from "fs/promises"
import z from "zod"
import matter from "gray-matter"
import { Tool } from "./tool"
import { Global } from "@/global"
import { OpenScience } from "@/openscience"
import { RSILifecycle } from "@/session/rsi/lifecycle"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.learn" })

const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

// A learned skill only loads if its SKILL.md carries `name` + `description`
// frontmatter (skill/skill.ts drops anything without it). Models sometimes pass
// a bare body, so guarantee a valid frontmatter block using the tool params —
// otherwise the write "succeeds" but the skill is silently unloadable forever.
function ensureFrontmatter(content: string, name: string, description: string): string {
  const parsed = (() => {
    try {
      return matter(content)
    } catch {
      return null
    }
  })()
  const hasName = typeof parsed?.data?.name === "string" && parsed.data.name.length > 0
  const hasDesc = typeof parsed?.data?.description === "string" && parsed.data.description.length > 0
  if (parsed && hasName && hasDesc && parsed.data.name === name) return content
  const body = (parsed ? parsed.content : content).replace(/^\s+/, "")
  const rest = parsed?.data && Object.keys(parsed.data).length > 0 ? { ...parsed.data } : {}
  delete (rest as Record<string, unknown>).name
  delete (rest as Record<string, unknown>).description
  const extra = Object.entries(rest)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  const fm = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "source: learn", ...extra, "---", ""]
  return `${fm.join("\n")}\n${body}`
}

export const LearnTool = Tool.define("learn", {
  description:
    "Save a learned skill distilled from conversation analysis. Writes SKILL.md to disk, uploads to cloud, and registers for lifecycle tracking. Called as the final step of /learn analysis.",
  parameters: z.object({
    name: z.string().describe("Skill identifier (kebab-case, e.g. 'debug-oom-pytorch')"),
    description: z.string().describe("One-line description of what this skill teaches"),
    content: z.string().describe("Full SKILL.md content including frontmatter"),
  }),
  async execute(params, ctx) {
    if (!SKILL_NAME_RE.test(params.name)) {
      throw new Error(
        `Invalid skill name "${params.name}". Use kebab-case: letters, digits, - or _, starting alphanumeric (e.g. 'debug-oom-pytorch').`,
      )
    }
    const dir = path.join(Global.Path.data, "learned-skills", params.name)
    const filepath = path.join(dir, "SKILL.md")

    const content = ensureFrontmatter(params.content, params.name, params.description)
    if (content !== params.content) {
      log.warn("learned skill missing valid frontmatter — injected from params", { name: params.name })
    }

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(filepath, content)
    log.info("learned skill written", { name: params.name, path: filepath })

    const uploaded = await OpenScience.uploadLearnedSkill(params.name, params.description, content, {
      agent: ctx.agent,
      score: 0,
    }).catch(() => false)

    await RSILifecycle.registerSkill(params.name).catch(() => {})

    return {
      title: `Learned skill: ${params.name}`,
      output: [
        `Learned skill "${params.name}" saved successfully.`,
        `  Path: ${filepath}`,
        `  Cloud: ${uploaded ? "uploaded" : "local only (upload failed or no session)"}`,
        `  Description: ${params.description}`,
        "",
        "The skill will be available in future sessions via the skill tool.",
      ].join("\n"),
      metadata: { name: params.name, uploaded },
    }
  },
})
