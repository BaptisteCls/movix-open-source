export interface ExclusiveCategory<T extends { id: number }> {
  id: string;
  title: string;
  items: T[];
}

interface ExclusiveCategoryOptions {
  minItems?: number;
  limit?: number;
  perCategoryLimit?: number;
  initialUsedIds?: Iterable<number>;
}

export const getMinimumCarouselCategoryItems = () => {
  if (typeof window === 'undefined') {
    return 5;
  }

  const width = window.innerWidth;
  if (width >= 1536) return 7;
  if (width >= 1280) return 6;
  if (width >= 1024) return 5;
  if (width >= 768) return 4;
  return 3;
};

export const makeExclusiveCategories = <T extends { id: number }>(
  categories: Array<ExclusiveCategory<T>>,
  {
    minItems = 1,
    limit = categories.length,
    perCategoryLimit = Number.POSITIVE_INFINITY,
    initialUsedIds = [],
  }: ExclusiveCategoryOptions = {},
): Array<ExclusiveCategory<T>> => {
  const usedIds = new Set<number>(initialUsedIds);
  const exclusiveCategories: Array<ExclusiveCategory<T>> = [];

  for (const category of categories) {
    const distinctItems: T[] = [];

    for (const item of category.items) {
      if (usedIds.has(item.id)) {
        continue;
      }

      distinctItems.push(item);
      usedIds.add(item.id);

      if (distinctItems.length >= perCategoryLimit) {
        break;
      }
    }

    if (distinctItems.length >= minItems) {
      exclusiveCategories.push({
        ...category,
        items: distinctItems,
      });
    }

    if (exclusiveCategories.length >= limit) {
      break;
    }
  }

  return exclusiveCategories;
};
