import type { Preview } from "@storybook/react-vite";
import { ThemeProvider } from "../src/ThemeProvider";
import "../src/styles.css";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: "error",
    },
  },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div style={{ padding: "1.5rem" }}>
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
};

export default preview;
