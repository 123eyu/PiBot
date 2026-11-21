import "./src/runtime/polyfills.ts";
import { installWakeTask } from "./src/push/wake-task.ts";

installWakeTask();

import "expo-router/entry";
