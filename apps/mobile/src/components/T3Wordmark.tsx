import type { ColorValue } from "react-native";
import { Image } from "expo-image";

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Image
      accessibilityLabel="T3CH"
      source={require("../../../../assets/t3ch/app-icon.png")}
      style={{ width: props.height, height: props.height }}
    />
  );
}
