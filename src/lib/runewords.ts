import { RUNE_NAMES, RUNEWORDS, type RuneName, type Runeword } from "../data/runewords.generated";

export type RuneCounts = Record<RuneName, number>;

export type MatchedRuneword = Runeword & {
  maxCrafts: number;
};

export const emptyRuneCounts = (): RuneCounts =>
  Object.fromEntries(RUNE_NAMES.map((rune) => [rune, 0])) as RuneCounts;

export function getRuneDemand(recipe: readonly RuneName[]) {
  const demand = new Map<RuneName, number>();
  recipe.forEach((rune) => {
    demand.set(rune, (demand.get(rune) ?? 0) + 1);
  });
  return demand;
}

export function findCraftableRunewords(counts: RuneCounts): MatchedRuneword[] {
  return RUNEWORDS.flatMap((word) => {
    const demand = getRuneDemand(word.recipe);
    const maxCrafts = Math.min(
      ...Array.from(demand.entries()).map(([rune, needed]) => Math.floor((counts[rune] ?? 0) / needed)),
    );

    if (maxCrafts < 1) {
      return [];
    }

    return [{ ...word, maxCrafts }];
  }).sort((a, b) => b.sockets - a.sockets || a.name.localeCompare(b.name));
}

export function formatRecipe(recipe: readonly RuneName[]) {
  return recipe.join(" + ");
}

export { RUNE_NAMES, RUNEWORDS };
export type { RuneName, Runeword };
