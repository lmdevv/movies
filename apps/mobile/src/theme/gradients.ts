/**
 * Gradients from Paper's 00 Artwork kit. Paper blends them in OKLab; these stops sample that blend
 * in sRGB closely enough that a plain linear gradient draws the same ramp.
 */

/** Two or more color stops with their positions from 0 to 1. */
export interface Gradient {
  readonly colors: readonly [string, string, ...string[]];
  readonly locations: readonly [number, number, ...number[]];
}

/** Backgrounds of the illustrated artwork, top to bottom (The Bear at 160deg, Interstellar radial). */
export const artGradients = {
  poorThings: {
    colors: [
      "#3A1A4A",
      "#552656",
      "#723262",
      "#903E6E",
      "#B04A7A",
      "#C0607C",
      "#D1767D",
      "#E28B7C",
      "#F2A07A",
    ],
    locations: [0, 0.1125, 0.225, 0.3375, 0.45, 0.5875, 0.725, 0.8625, 1],
  },
  wildRobot: {
    colors: [
      "#0F2A3A",
      "#143445",
      "#193F51",
      "#1F4A5D",
      "#25566A",
      "#326973",
      "#417C7B",
      "#508F83",
      "#5FA38A",
    ],
    locations: [0, 0.1375, 0.275, 0.4125, 0.55, 0.6625, 0.775, 0.8875, 1],
  },
  dune: {
    colors: [
      "#3B2414",
      "#53301A",
      "#6C3D1F",
      "#864A25",
      "#A2582A",
      "#B26A39",
      "#C27D48",
      "#D39056",
      "#E3A365",
      "#E7AE71",
      "#EBB97D",
      "#EEC488",
      "#F2CF94",
    ],
    locations: [0, 0.095, 0.19, 0.285, 0.38, 0.44, 0.5, 0.56, 0.62, 0.715, 0.81, 0.905, 1],
  },
  theBear: {
    colors: ["#5E1A16", "#501713", "#431310", "#36100E", "#2A0D0B"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  bladeRunner: {
    colors: [
      "#B5541E",
      "#C06126",
      "#CB6F2D",
      "#D57C34",
      "#E08A3B",
      "#E59548",
      "#E9A054",
      "#EEAB5F",
      "#F2B66A",
    ],
    locations: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1],
  },
  interstellar: {
    colors: ["#1A1410", "#14100D", "#0F0C0A", "#090807", "#050505"],
    locations: [0, 0.175, 0.35, 0.525, 0.7],
  },
  fargo: {
    colors: [
      "#C9D2D8",
      "#D2DADF",
      "#DBE1E5",
      "#E5E9EB",
      "#EEF1F2",
      "#F0F3F3",
      "#F2F4F5",
      "#F5F6F6",
      "#F7F8F8",
    ],
    locations: [0, 0.15, 0.3, 0.45, 0.6, 0.7, 0.8, 0.9, 1],
  },
  sicario: {
    colors: [
      "#1C1A2A",
      "#2F232C",
      "#422B2C",
      "#56322C",
      "#6B3A2A",
      "#874A2F",
      "#A45A33",
      "#C26A37",
      "#E07B3A",
      "#E68943",
      "#EB974C",
      "#EFA555",
      "#F4B35E",
    ],
    locations: [0, 0.125, 0.25, 0.375, 0.5, 0.57, 0.64, 0.71, 0.78, 0.835, 0.89, 0.945, 1],
  },
  arrival: {
    colors: [
      "#9AA3A6",
      "#A4ADAF",
      "#AFB6B8",
      "#B9C0C2",
      "#C4CACB",
      "#B2BAB9",
      "#A0AAA7",
      "#8E9A95",
      "#7D8A84",
    ],
    locations: [0, 0.1375, 0.275, 0.4125, 0.55, 0.6625, 0.775, 0.8875, 1],
  },
  topGun: {
    colors: [
      "#1E3550",
      "#2D4865",
      "#3C5C7B",
      "#4C7191",
      "#5C86A8",
      "#8097A7",
      "#A3A7A5",
      "#C6B7A0",
      "#E9C79A",
    ],
    locations: [0, 0.1375, 0.275, 0.4125, 0.55, 0.6625, 0.775, 0.8875, 1],
  },
} as const satisfies Readonly<Record<string, Gradient>>;

/** Profile avatars, top left to bottom right, by the avatar keys profiles store. */
export const avatarGradients = {
  red: {
    colors: ["#FF5A4F", "#EB4940", "#D83831", "#C52422", "#B20610"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  blue: {
    colors: ["#6EA8FF", "#5990ED", "#4678DB", "#3461CA", "#2448B8"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  green: {
    colors: ["#7FD49A", "#68BD84", "#52A66E", "#3B9059", "#227A45"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  plum: {
    colors: ["#C98BE8", "#B073D1", "#985CBA", "#8144A4", "#6A2C8E"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  teal: {
    colors: ["#6FE0D6", "#59C6BC", "#44ACA3", "#2D938A", "#127A72"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  slate: {
    colors: ["#A9B4C2", "#909BA9", "#788391", "#616B7A", "#4A5563"],
    locations: [0, 0.25, 0.5, 0.75, 1],
  },
  kids: {
    colors: [
      "#FFD259",
      "#FFBD5A",
      "#FFA85A",
      "#FF9159",
      "#FF7A59",
      "#FC7169",
      "#F86777",
      "#F55C83",
      "#F2508E",
    ],
    locations: [0, 0.1375, 0.275, 0.4125, 0.55, 0.6625, 0.775, 0.8875, 1],
  },
} as const satisfies Readonly<Record<string, Gradient>>;
