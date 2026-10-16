/**
 * The illustrated artwork of Paper's 00 Artwork kit, drawn as vectors. Screens before sign-in
 * (Connect, Sign in, Who's watching) have no server artwork to show yet, so they use these, as
 * Paper does. Each piece is a 320×180 scene over its gradient that fills any frame, center-cropped.
 */
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from "react-native-svg";

import { artGradients } from "@/theme/gradients";

/** A piece of the artwork kit, by the title it stands for. */
export type ArtworkName =
  | "dune"
  | "severance"
  | "interstellar"
  | "arrival"
  | "theBear"
  | "fargo"
  | "poorThings"
  | "sicario"
  | "topGun"
  | "wildRobot"
  | "bladeRunner";

const SCENES: Readonly<Record<ArtworkName, ReactNode>> = {
  dune: (
    <>
      <Circle cx="214" cy="74" r="30" fill="#FBE3B4" opacity={0.9} />
      <Circle cx="214" cy="74" r="52" fill="#FBE3B4" opacity={0.12} />
      <Path
        d="M0 120 C60 96 110 104 170 116 C220 126 270 100 320 108 L320 180 L0 180 Z"
        fill="#B8692F"
      />
      <Path
        d="M0 138 C70 118 120 128 190 140 C240 148 280 132 320 134 L320 180 L0 180 Z"
        fill="#8A4720"
      />
      <Path
        d="M0 158 C80 146 150 152 220 162 C260 168 300 160 320 160 L320 180 L0 180 Z"
        fill="#4E2611"
      />
      <Path d="M96 128 l3 -10 l3 10 z" fill="#2A140A" />
    </>
  ),
  severance: (
    <>
      <Path d="M0 0 L320 0 L196 70 L124 70 Z" fill="#DCE6E2" />
      <Path d="M0 180 L320 180 L196 104 L124 104 Z" fill="#2C5A55" />
      <Path d="M0 0 L124 70 L124 104 L0 180 Z" fill="#B9CCC7" />
      <Path d="M320 0 L196 70 L196 104 L320 180 Z" fill="#C9D8D4" />
      <Rect x="124" y="70" width="72" height="34" fill="#F4F8F6" />
      <Rect x="150" y="76" width="20" height="28" fill="#1E3B39" />
      <Path d="M0 22 L124 76 M320 22 L196 76" stroke="#FFFFFF80" strokeWidth="1.5" />
      <Path d="M40 160 L136 104 M280 160 L184 104" stroke="#4B8079" />
      <Rect x="157" y="88" width="6" height="16" rx="3" fill="#0B1514" />
    </>
  ),
  interstellar: (
    <>
      <Ellipse
        cx="160"
        cy="92"
        rx="118"
        ry="18"
        fill="none"
        stroke="#F3B35C"
        strokeWidth="7"
        opacity={0.85}
      />
      <Ellipse
        cx="160"
        cy="92"
        rx="140"
        ry="24"
        fill="none"
        stroke="#E07A2E"
        strokeWidth="2"
        opacity={0.5}
      />
      <Circle cx="160" cy="88" r="40" fill="none" stroke="#FFD9A0" strokeWidth="5" opacity={0.9} />
      <Circle cx="160" cy="88" r="36" fill="#000000" />
      <Path d="M42 92 A118 18 0 0 0 278 92" fill="none" stroke="#FFE2B5" strokeWidth="4" />
      <Circle cx="34" cy="28" r="1" fill="#FFFFFF" />
      <Circle cx="270" cy="34" r="1.2" fill="#FFFFFF" />
      <Circle cx="290" cy="150" r="0.8" fill="#FFFFFF" />
      <Circle cx="60" cy="150" r="1" fill="#FFFFFF" opacity={0.7} />
      <Circle cx="220" cy="20" r="0.8" fill="#FFFFFF" opacity={0.8} />
    </>
  ),
  arrival: (
    <>
      <Ellipse cx="176" cy="74" rx="22" ry="58" fill="#2A2F30" />
      <Ellipse cx="170" cy="70" rx="8" ry="46" fill="#3C4345" opacity={0.6} />
      <Rect x="0" y="96" width="320" height="22" fill="#D7DCDC" opacity={0.55} />
      <Path
        d="M0 140 C60 128 120 134 190 132 C250 130 290 136 320 134 L320 180 L0 180 Z"
        fill="#4C5A52"
      />
      <Path d="M0 154 C80 146 160 152 320 150 L320 180 L0 180 Z" fill="#33403A" />
      <Path d="M68 138 l1.5 -6 l1.5 6 z M76 139 l1.2 -5 l1.2 5 z" fill="#1E2622" />
    </>
  ),
  theBear: (
    <>
      <G opacity={0.22}>
        <Path
          d="M0 30 H320 M0 60 H320 M0 90 H320 M0 120 H320 M0 150 H320"
          stroke="#F1D9C9"
          strokeWidth="0.8"
        />
        <Path
          d="M40 0 V180 M80 0 V180 M120 0 V180 M160 0 V180 M200 0 V180 M240 0 V180 M280 0 V180"
          stroke="#F1D9C9"
          strokeWidth="0.8"
        />
      </G>
      <Rect x="0" y="118" width="320" height="62" fill="#1A0706" />
      <Rect x="0" y="114" width="320" height="6" fill="#C9C2BA" />
      <Circle cx="96" cy="40" r="22" fill="#F7C873" opacity={0.18} />
      <Path d="M90 0 V22 M102 0 V22" stroke="#5A2A20" strokeWidth="2" />
      <Path d="M84 22 H108 L102 34 H90 Z" fill="#E9B45E" />
      <Circle cx="224" cy="40" r="22" fill="#F7C873" opacity={0.18} />
      <Path d="M218 0 V22 M230 0 V22" stroke="#5A2A20" strokeWidth="2" />
      <Path d="M212 22 H236 L230 34 H218 Z" fill="#E9B45E" />
      <Path d="M140 114 V96 H180 V114" fill="#8E8A85" />
      <Ellipse cx="160" cy="96" rx="20" ry="4" fill="#B5B0AA" />
    </>
  ),
  fargo: (
    <>
      <Path d="M0 104 H320" stroke="#A9B4BA" />
      <Path d="M150 104 L170 104 L250 180 L70 180 Z" fill="#5B6267" />
      <Path
        d="M160 108 L160 116 M160 126 L160 138 M160 150 L160 168"
        stroke="#F5E7A6"
        strokeWidth="2"
      />
      <G fill="#2E3438">
        <Path d="M30 104 l8 -26 l8 26 z" />
        <Path d="M44 104 l6 -18 l6 18 z" />
        <Path d="M262 104 l7 -22 l7 22 z" />
        <Path d="M276 104 l9 -30 l9 30 z" />
        <Path d="M292 104 l5 -14 l5 14 z" />
      </G>
      <Rect x="200" y="96" width="14" height="6" rx="1.5" fill="#8C2A23" />
      <Circle cx="203" cy="103" r="1.5" fill="#1A1A1A" />
      <Circle cx="211" cy="103" r="1.5" fill="#1A1A1A" />
    </>
  ),
  poorThings: (
    <>
      <Circle cx="60" cy="50" r="14" fill="#FFD3B0" opacity={0.85} />
      <Path
        d="M90 60 C110 40 140 44 150 58 C170 48 196 56 196 72 C214 72 222 86 210 94 L96 94 C80 92 76 72 90 60 Z"
        fill="#F6C6D6"
        opacity={0.8}
      />
      <Path
        d="M200 34 C214 22 236 26 240 38 C256 34 270 44 264 54 L206 54 C196 52 194 40 200 34 Z"
        fill="#FFE1C4"
        opacity={0.7}
      />
      <Path
        d="M0 138 C40 128 80 132 120 140 C170 150 230 126 320 132 L320 180 L0 180 Z"
        fill="#3D1F3F"
      />
      <Path d="M0 160 C90 150 200 160 320 154 L320 180 L0 180 Z" fill="#1E0F22" />
      <Path
        d="M248 132 V100 M244 104 C248 96 252 96 256 104"
        fill="none"
        stroke="#1E0F22"
        strokeWidth="3"
      />
    </>
  ),
  sicario: (
    <>
      <Path
        d="M0 132 L30 132 L38 112 L84 112 L92 132 L196 132 L204 104 L262 104 L270 132 L320 132 L320 180 L0 180 Z"
        fill="#2A1712"
      />
      <Path d="M0 150 H320 V180 H0 Z" fill="#140A08" />
      <G fill="#0A0505">
        <Rect x="120" y="128" width="3" height="10" />
        <Rect x="126" y="127" width="3" height="11" />
        <Rect x="132" y="128" width="3" height="10" />
        <Rect x="138" y="127" width="3" height="11" />
      </G>
      <Circle cx="250" cy="40" r="1" fill="#FFFFFF" opacity={0.6} />
      <Circle cx="60" cy="30" r="0.8" fill="#FFFFFF" opacity={0.5} />
    </>
  ),
  topGun: (
    <>
      <Path d="M-10 150 C80 120 160 90 236 60" fill="none" stroke="#FFFFFF8C" strokeWidth="3" />
      <Path d="M-10 156 C80 126 160 96 236 66" fill="none" stroke="#FFFFFF4D" strokeWidth="2" />
      <Path
        d="M236 62 L262 50 L268 52 L246 64 L258 70 L254 72 L240 68 L230 72 L232 66 Z"
        fill="#1B2430"
      />
      <Path
        d="M0 160 C60 150 120 156 180 152 C240 148 290 156 320 152 L320 180 L0 180 Z"
        fill="#3F3A34"
      />
    </>
  ),
  wildRobot: (
    <>
      <Circle cx="232" cy="46" r="22" fill="#F7EBC2" />
      <Circle cx="232" cy="46" r="40" fill="#F7EBC2" opacity={0.12} />
      <G fill="#1B3E2E">
        <Path d="M10 150 l18 -60 l18 60 z" />
        <Path d="M34 150 l14 -44 l14 44 z" />
        <Path d="M262 150 l16 -54 l16 54 z" />
        <Path d="M286 150 l12 -40 l12 40 z" />
      </G>
      <Path d="M0 146 C80 136 240 136 320 146 L320 180 L0 180 Z" fill="#12291F" />
      <Rect x="146" y="104" width="20" height="26" rx="6" fill="#D9D4C7" />
      <Circle cx="156" cy="96" r="9" fill="#D9D4C7" />
      <Circle cx="153" cy="95" r="2" fill="#F2A65A" />
      <Circle cx="160" cy="95" r="2" fill="#F2A65A" />
      <Path d="M150 130 v12 M162 130 v12" stroke="#D9D4C7" strokeWidth="4" strokeLinecap="round" />
      <Path d="M174 120 l8 -4 l2 3 l-8 4 z" fill="#E07A3A" />
    </>
  ),
  bladeRunner: (
    <>
      <G fill="#7A3414" opacity={0.55}>
        <Rect x="20" y="40" width="40" height="140" />
        <Rect x="250" y="20" width="50" height="160" />
      </G>
      <G fill="#5A240C" opacity={0.8}>
        <Rect x="70" y="70" width="34" height="110" />
        <Rect x="214" y="56" width="30" height="124" />
      </G>
      <Path
        d="M120 180 C130 120 142 90 160 82 C178 90 190 120 200 180 Z"
        fill="#3A1606"
        opacity={0.6}
      />
      <Rect x="157" y="132" width="6" height="22" rx="3" fill="#1E0A02" />
      <Circle cx="160" cy="128" r="4" fill="#1E0A02" />
      <Rect x="0" y="154" width="320" height="26" fill="#C66A2A" opacity={0.5} />
    </>
  ),
};

/** Severance sits on a flat color; Interstellar on a radial glow; the rest on linear gradients. */
function Backdrop({ name }: { readonly name: ArtworkName }) {
  if (name === "severance") return <View style={[StyleSheet.absoluteFill, styles.severance]} />;

  if (name === "interstellar") {
    const { colors, locations } = artGradients.interstellar;

    return (
      <Svg
        width="100%"
        height="100%"
        style={StyleSheet.absoluteFill}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="50%" r="71%">
            {colors.map((color, index) => (
              <Stop key={color} offset={locations[index] ?? 1} stopColor={color} />
            ))}
          </RadialGradient>
        </Defs>
        <Rect width="100" height="100" fill="url(#glow)" />
      </Svg>
    );
  }

  const { colors, locations } = artGradients[name];
  // The Bear's ramp runs at 160deg, the others straight down.
  const end = name === "theBear" ? { x: 0.34, y: 1 } : { x: 0, y: 1 };

  return (
    <LinearGradient
      style={StyleSheet.absoluteFill}
      colors={colors}
      locations={locations}
      start={{ x: 0, y: 0 }}
      end={end}
    />
  );
}

/** Props for `Artwork`. */
interface ArtworkProps {
  readonly name: ArtworkName;
  /** The frame; the art fills it, center-cropped. */
  readonly style?: StyleProp<ViewStyle>;
}

/** One piece of the artwork kit filling its frame. */
export function Artwork({ name, style }: ArtworkProps) {
  return (
    <View style={[styles.frame, style]} pointerEvents="none">
      <Backdrop name={name} />
      <Svg
        width="100%"
        height="100%"
        style={StyleSheet.absoluteFill}
        viewBox="0 0 320 180"
        preserveAspectRatio="xMidYMid slice"
      >
        {SCENES[name]}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden" },
  severance: { backgroundColor: "#0E1A1C" },
});
