export * from './interfaces';
export * from './definitions';
import { GlobalConfig } from './definitions';

const configValues = new Map<string, any>();

function loadConfigValues(obj: any, parentPath: string = ''): void {
  Object.entries(obj).forEach(([key, value]) => {
    const path = parentPath ? `${parentPath}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      loadConfigValues(value, path);
    } else {
      configValues.set(path, value);
    }
  });
}

loadConfigValues(GlobalConfig);

/**
 * Helper function to get a configuration value
 * @param path Dot-notation path to the config
 * @returns The config value or undefined if not found
 */
export function getConfig<T>(path: string): T | undefined {
  return configValues.get(path) as T | undefined;
}

/**
 * Helper function to set a configuration value
 * @param path Dot-notation path to the config
 * @param value The new value
 */
export function setConfig<T>(path: string, value: T): void {
  configValues.set(path, value);
}
