import fs from "fs";
import path from "path";

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";

import { Metafile } from "esbuild";

const getClient = () => {
  const githubToken = core.getInput("github_token") || process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error(
      "GitHub token not found; looked in env.GITHUB_TOKEN and input.github_token"
    );
  }

  return getOctokit(githubToken);
};

const findComment = async () => {
  const comments = await getClient().rest.issues.listComments({
    owner: context.issue.owner,
    repo: context.issue.repo,
    issue_number: context.issue.number,
  });

  const identifier = "<!-- esbuild-bundle-size-diff-comment -->";

  for (const comment of comments.data) {
    if (comment.body?.startsWith(identifier)) {
      return comment.id;
    }
  }

  return null;
};

const comment = async (message: string) => {
  const client = getClient();
  const commentId = await findComment();

  if (commentId) {
    await client.rest.issues.updateComment({
      owner: context.issue.owner,
      repo: context.issue.repo,
      comment_id: commentId,
      body: message,
    });
    return;
  }

  await client.rest.issues.createComment({
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    body: message,
  });
};

const computeSizeByEntrypoint = (metafile: Metafile) => {
  const result: Record<string, { path: string; bytes: number }[]> = {}; // entrypoint -> size in bytes

  Object.entries(metafile.outputs).forEach(([path, output]) => {
    const { entryPoint, bytes, cssBundle } = output;
    if (!entryPoint) return;

    // size is bytes + css file size
    result[entryPoint] ||= [];
    result[entryPoint].push({ path, bytes });

    if (cssBundle) {
      const cssOutput = metafile.outputs[cssBundle];
      if (cssOutput) {
        if (!result[entryPoint].find(({ path }) => path === cssBundle)) {
          result[entryPoint].push({ path: cssBundle, bytes: cssOutput.bytes });
        }
      }
    }
  });

  return result;
};

function bytesToSize(bytes: number) {
  if (!isFinite(bytes)) return "";

  const units = ["byte", "kilobyte", "megabyte", "terabyte", "petabyte"];
  const unitIdx = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = isFinite(unitIdx)
    ? units[unitIdx > units.length ? units.length - 1 : unitIdx]
    : units[0];

  return new Intl.NumberFormat("en", {
    style: "unit",
    unitDisplay: "narrow",
    unit,
    maximumFractionDigits: 2,
  }).format(bytes == 0 ? 0 : bytes / 1024 ** unitIdx);
}

function escapePipes(str: string) {
  return str.replace(/\|/g, "\\|");
}

const diff = (baseMetafile: Metafile, prMetafile: Metafile) => {
  const baseSizes = computeSizeByEntrypoint(baseMetafile);
  const prSizes = computeSizeByEntrypoint(prMetafile);

  // generate filesize diff table
  const entrypoints = [
    ...new Set([...Object.keys(baseSizes), ...Object.keys(prSizes)]),
  ].sort();

  const columnHeadings = ["Entrypoint", "Path", "Old size", "New size", "Diff"];
  const result: string[][] = [];
  result.push(columnHeadings);
  result.push(columnHeadings.map(() => "---"));

  entrypoints.forEach((entrypoint) => {
    const baseSize = baseSizes[entrypoint] ?? [];
    const prSize = prSizes[entrypoint] ?? [];

    const baseSizeTotal = baseSize.reduce((acc, { bytes }) => acc + bytes, 0);
    const prSizeTotal = prSize.reduce((acc, { bytes }) => acc + bytes, 0);
    const diffSizeTotal = prSizeTotal - baseSizeTotal;
    const percentChange = ((prSizeTotal - baseSizeTotal) / baseSizeTotal) * 100;

    result.push([
      entrypoint,
      "*",
      bytesToSize(baseSizeTotal),
      bytesToSize(prSizeTotal),
      `${bytesToSize(diffSizeTotal)} (${percentChange.toFixed(2)}%)`,
    ]);

    const paths = [
      ...new Set([
        ...baseSize.map(({ path }) => path),
        ...prSize.map(({ path }) => path),
      ]),
    ].sort();
    paths.forEach((path) => {
      const baseItem = baseSize.find(({ path: p }) => p === path);
      const prItem = prSize.find(({ path: p }) => p === path);
      const diffSizeTotal =
        baseItem !== undefined && prItem !== undefined
          ? prItem.bytes - baseItem.bytes
          : 0;

      result.push(
        [
          "",
          path,
          baseItem?.bytes !== undefined ? bytesToSize(baseItem?.bytes) : "n/a",
          prItem?.bytes !== undefined ? bytesToSize(prItem?.bytes) : "n/a",
          baseItem === undefined
            ? "new"
            : prItem === undefined
            ? "deleted"
            : `${bytesToSize(diffSizeTotal)} (${percentChange.toFixed(2)}%)`,
        ].map((str) => "<sub>" + str + "</sub>") // <sub> makes the text smaller, h/t https://stackoverflow.com/questions/66380290/how-to-use-smaller-font-size-in-a-github-table
      );
    });
  });

  return result
    .map((row) => "| " + row.map(escapePipes).join(" | ") + " |")
    .join("\n");
};

const run = async () => {
  const { basePath, prPath } = {
    basePath: core.getInput("base_path"),
    prPath: core.getInput("pr_path"),
  };
  const base = path.resolve(process.cwd(), basePath);
  const pr = path.resolve(process.cwd(), prPath);

  // open "base" and read content
  const baseMetafile = JSON.parse(fs.readFileSync(base, "utf8")) as Metafile;
  const prMetafile = JSON.parse(fs.readFileSync(pr, "utf8")) as Metafile;

  const resultMarkdownTable = diff(baseMetafile, prMetafile);
  comment(`
  ## Bundle size diff

  ${resultMarkdownTable}
  `);
};

// yarn ts-node <metafileA> <metafileB>
const main = async (base: string, pr: string) => {
  const baseMetafile = JSON.parse(fs.readFileSync(base, "utf8")) as Metafile;
  const prMetafile = JSON.parse(fs.readFileSync(pr, "utf8")) as Metafile;

  const resultMarkdownTable = diff(baseMetafile, prMetafile);
  console.log(resultMarkdownTable);
};

if (process.argv.length >= 4) {
  // local CLI codepath
  const base = process.argv[2];
  const pr = process.argv[3];
  main(base, pr);
} else {
  // Github Actions codepath
  run();
}
