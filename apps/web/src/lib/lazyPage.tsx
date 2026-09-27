import { use, type ComponentType } from "react";

export interface LazyPage<P extends object> {
  (props: P): React.ReactElement;
  /** Starts loading the module (once); resolves when the page can render without suspending. */
  preload: () => Promise<void>;
}

/**
 * Like React.lazy, but the page can be loaded ahead of rendering. main.tsx preloads the
 * current page before hydrating prerendered HTML: a boundary that suspends while hydrating is
 * thrown away and re-rendered from scratch as soon as any context above it changes (e.g. auth
 * finishing), which blanks the page and shifts the layout. Once loaded, it renders
 * synchronously; before that it suspends like React.lazy.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): LazyPage<P> {
  let Loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const loadOnce = () =>
    (loading ??= load().then((component) => {
      Loaded = component;
      return component;
    }));
  const preload = async () => {
    await loadOnce();
  };

  const Page = (props: P) => {
    const Component = Loaded ?? use(loadOnce());
    return <Component {...props} />;
  };
  Page.preload = preload;
  return Page;
}
