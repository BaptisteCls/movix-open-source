const range = (start: number, end: number): number[] => Array.from({ length: end - start + 1 }, (_, idx) => start + idx);

const buildAvatarPaths = (folder: string, prefix: string, numbers: number[]): string[] =>
    numbers.map((num) => `/avatars/${folder}/${prefix}_${num}.png`);

const disney = buildAvatarPaths('disney', 'disney_avatar', range(1, 53).filter((n) => n !== 16));
const disneyChannel = buildAvatarPaths('disney_channel', 'disneychannel_avatar', range(1, 37));
const marvel = buildAvatarPaths('marvel', 'marvel_avatar', range(1, 35));
const mickey = buildAvatarPaths('mickey', 'mickey_avatar', range(1, 15));
const pixar = buildAvatarPaths('pixar', 'pixar_avatar', range(1, 47));
const simpsons = buildAvatarPaths('simpsons', 'simpson_avatar', range(1, 8));
const starwars = buildAvatarPaths('starwars', 'starwars_avatar', range(1, 34));

export const avatarCategories: Record<string, string[]> = {
    'Disney': disney,
    'Disney Channel': disneyChannel,
    'Marvel': marvel,
    'Mickey': mickey,
    'Pixar': pixar,
    'Simpsons': simpsons,
    'Star Wars': starwars,
};

export const predefinedAvatars: string[] = Object.values(avatarCategories).flat();