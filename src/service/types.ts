export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  detail?: string;
}

export interface ServiceAdapter {
  readonly platform: 'linux' | 'darwin' | 'win32';
  /** Write unit file / plist / task. Does NOT start or enable. */
  install(execPath: string, port: number): Promise<void>;
  /** Remove unit file / plist / task. */
  uninstall(): Promise<void>;
  /** Start the service via the OS init system. */
  start(): Promise<void>;
  /** Stop the service via the OS init system. */
  stop(): Promise<void>;
  /** Query current status. */
  status(): Promise<ServiceStatus>;
}
