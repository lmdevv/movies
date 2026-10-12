# NixOS module for [movies]: the self-hosted Convex backend as a pinned OCI container, and the
# media service (which also serves the web app) as a native, hardened systemd service built from
# this repository (nix/package.nix).
#
#   services.movies = {
#     enable = true;
#     libraryDirs = [ "/srv/media/movies" "/srv/media/shows" ];
#     # Reached over Tailscale; see README.md.
#     listenAddress = "100.64.0.1";
#     publicUrl = "http://nas.tailnet.ts.net:8080";
#     convexPublicUrl = "http://nas.tailnet.ts.net:3210";
#     hardwareAcceleration = "qsv";
#     tmdbApiKeyFile = "/run/secrets/tmdb-api-key";
#   };
#
# Every startup derives the Convex admin key from the backend's instance secret, backs up before
# an upgrade, deploys the bundled functions, configures the deployment (keys and secrets are
# generated inside Convex and kept there), and writes the service's environment to
# /run/movies/media.env, readable by the service user only. No secret enters the Nix store.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.movies;

  # Keep in step with deploy/compose/compose.yaml, deploy/compose/Dockerfile, and
  # scripts/dev-stack.sh.
  convexImage = "ghcr.io/get-convex/convex-backend:5c7cb5bc7db457290f1769f95f1d1340912f7fd7@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4";

  backend = config.virtualisation.oci-containers.backend;
  containerRuntime = lib.getExe pkgs.${backend};
  containerUnit = "${backend}-movies-convex.service";

  hardware = cfg.hardwareAcceleration != "none";
  localAddress = if cfg.listenAddress == "0.0.0.0" then "127.0.0.1" else cfg.listenAddress;
  convexUrl = "http://${localAddress}:${toString cfg.convexPort}";
  convexDataDir = "${cfg.dataDir}/convex";
  mediaDataDir = "${cfg.dataDir}/media";

  setup = pkgs.writeShellApplication {
    name = "movies-setup";
    runtimeInputs = [
      cfg.package
      pkgs.coreutils
      pkgs.curl
      pkgs.gnused
    ];
    text = ''
      umask 077
      log() { echo "movies-setup: $*" >&2; }

      convex_url=${lib.escapeShellArg convexUrl}
      public_url=${lib.escapeShellArg cfg.publicUrl}
      convex_public_url=${lib.escapeShellArg cfg.convexPublicUrl}
      backup_dir=${lib.escapeShellArg cfg.backupDir}
      owner=${lib.escapeShellArg "${cfg.user}:${cfg.group}"}
      version=${lib.escapeShellArg cfg.package.version}
      version_file=${lib.escapeShellArg "${mediaDataDir}/version"}

      # The service's folders, in case they were removed since boot (tmpfiles creates them).
      install -d -m 700 -o ${lib.escapeShellArg cfg.user} -g ${lib.escapeShellArg cfg.group} \
        ${lib.escapeShellArgs [
          mediaDataDir
          cfg.backupDir
          cfg.transcodeDir
        ]}

      log "waiting for Convex at $convex_url"
      for _ in $(seq 1 120); do
        curl -fsS "$convex_url/version" >/dev/null 2>&1 && break
        sleep 1
      done
      curl -fsS "$convex_url/version" >/dev/null

      # The admin key is derived from the backend's instance secret on every start; it is never
      # stored on disk.
      admin_key="$(${containerRuntime} exec movies-convex ./generate_admin_key.sh | tail -n 1)"
      export CONVEX_SELF_HOSTED_URL="$convex_url"
      export CONVEX_SELF_HOSTED_ADMIN_KEY="$admin_key"

      if [ -s "$version_file" ] && [ "$(cat "$version_file")" != "$version" ]; then
        name="movies-manual-$(date -u +%Y-%m-%dT%H-%M-%S-000Z).zip"
        log "upgrading from $(cat "$version_file") to $version; backing up to $name first"
        movies-convex export --include-file-storage --path "$backup_dir/.partial-$name"
        mv "$backup_dir/.partial-$name" "$backup_dir/$name"
        chown "$owner" "$backup_dir/$name"
      fi

      log "deploying the Convex functions ($version)"
      movies-convex deploy --yes --codegen disable --typecheck disable

      log "configuring the deployment"
      # Prints MEDIA_SERVICE_API_KEY=... and PLAYBACK_TOKEN_SECRET=...; keeps existing secrets.
      media_env="$(movies-configure --site-url="$public_url" --media-url="$public_url")"
      media_service_api_key="$(sed -n 's/^MEDIA_SERVICE_API_KEY=//p' <<<"$media_env")"
      playback_token_secret="$(sed -n 's/^PLAYBACK_TOKEN_SECRET=//p' <<<"$media_env")"
      unset media_env

      umask 022
      movies-configure-web --to /run/movies/web --convex-url "$convex_public_url"
      printf '%s\n' "$version" >"$version_file"
      chown "$owner" "$version_file"

      # The service's secrets, readable by its user only.
      umask 077
      env_file=/run/movies/media.env
      install -m 600 -o ${lib.escapeShellArg cfg.user} -g ${lib.escapeShellArg cfg.group} /dev/null "$env_file"
      {
        printf 'MEDIA_SERVICE_API_KEY=%s\n' "$media_service_api_key"
        printf 'PLAYBACK_TOKEN_SECRET=%s\n' "$playback_token_secret"
        printf 'CONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$admin_key"
        ${lib.optionalString (cfg.tmdbApiKeyFile != null) ''
          printf 'TMDB_API_KEY=%s\n' "$(cat ${lib.escapeShellArg cfg.tmdbApiKeyFile})"
        ''}
      } >>"$env_file"
    '';
  };
in
{
  options.services.movies = {
    enable = lib.mkEnableOption "[movies], self-hosted movies and TV for people and agents";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The [movies] package: media service, web app, and Convex functions.";
    };

    ffmpegPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.ffmpeg-full;
      defaultText = lib.literalExpression "pkgs.ffmpeg-full";
      description = "ffmpeg and ffprobe. ffmpeg-full is built with libvpl, which Quick Sync needs.";
    };

    libraryDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "/srv/media/movies"
        "/mnt/nas/shows"
      ];
      description = ''
        Folders the media service may scan and stream, read-only. Add each one as a library in the
        web app. The service user must be able to read them (world-readable files and folders are),
        or put it in a group that can through `users.users.movies.extraGroups`.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/movies";
      description = ''
        State: the Convex database and file storage (`convex/`) and the media service's caches
        (`media/`).
      '';
    };

    backupDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/movies/backups";
      description = "Nightly database backups (Convex exports with file storage).";
    };

    backupRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 14;
      description = "Backups older than this are removed after a new backup succeeds.";
    };

    transcodeDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/cache/movies/transcode";
      description = "Disposable HLS segments. Put it on fast storage with a few GB free.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Port of the web app, API, and streams.";
    };

    convexPort = lib.mkOption {
      type = lib.types.port;
      default = 3210;
      description = "Port of the Convex backend, which browsers and the CLI use directly.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Listen on all interfaces and open both ports in the firewall.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = if cfg.openFirewall then "0.0.0.0" else "127.0.0.1";
      defaultText = lib.literalExpression ''if config.services.movies.openFirewall then "0.0.0.0" else "127.0.0.1"'';
      example = "100.64.0.1";
      description = ''
        Address both ports listen on. Container port publishing bypasses the NixOS firewall, so this,
        not the firewall, decides who can reach Convex. The default keeps [movies] local; set the
        host's Tailscale address to reach it over the tailnet only.
      '';
    };

    publicUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://localhost:${toString cfg.port}";
      defaultText = lib.literalExpression ''"http://localhost:''${toString config.services.movies.port}"'';
      description = "URL people use for the web app and streams.";
    };

    convexPublicUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://localhost:${toString cfg.convexPort}";
      defaultText = lib.literalExpression ''"http://localhost:''${toString config.services.movies.convexPort}"'';
      description = "URL browsers and the CLI use for Convex.";
    };

    hardwareAcceleration = lib.mkOption {
      type = lib.types.enum [
        "auto"
        "qsv"
        "none"
      ];
      default = "auto";
      description = ''
        Intel Quick Sync for transcoding. `auto` gives the service the render nodes and probes them,
        falling back to software encoding; `qsv` also enables the host's Intel media driver and
        oneVPL runtime (Gen12+, Tiger Lake and newer); `none` keeps the service away from the GPU.
      '';
    };

    maxConcurrentTranscodes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 3;
      description = "Upper bound on simultaneous video transcodes.";
    };

    tmdbApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/tmdb-api-key";
      description = ''
        File holding a TMDB v3 API key or v4 read access token, for metadata and artwork. Read at
        startup by root; keep it out of the Nix store (agenix, sops-nix, or a root-only file).
      '';
    };

    otlpEndpoint = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:4318";
      description = "OTLP/HTTP collector for traces and logs. Nothing is exported without it.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "movies";
      description = "User the media service runs as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "movies";
      description = "Group the media service runs as.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users = lib.mkIf (cfg.user == "movies") {
      movies = {
        isSystemUser = true;
        inherit (cfg) group;
        extraGroups = lib.optionals hardware [
          "render"
          "video"
        ];
      };
    };
    users.groups = lib.mkIf (cfg.group == "movies") { movies = { }; };

    hardware.graphics = lib.mkIf (cfg.hardwareAcceleration == "qsv") {
      enable = true;
      extraPackages = [
        pkgs.intel-media-driver
        pkgs.vpl-gpu-rt
      ];
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0711 root root -"
      "d ${convexDataDir} 0700 root root -"
      "d ${mediaDataDir} 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.backupDir} 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.transcodeDir} 0700 ${cfg.user} ${cfg.group} -"
    ];

    virtualisation.oci-containers.containers.movies-convex = {
      image = convexImage;
      ports = [ "${cfg.listenAddress}:${toString cfg.convexPort}:3210" ];
      environment = {
        CONVEX_CLOUD_ORIGIN = cfg.convexPublicUrl;
        # HTTP actions (Convex Auth's JWKS) stay inside the container.
        CONVEX_SITE_ORIGIN = "http://127.0.0.1:3211";
        DISABLE_BEACON = "1";
        REDACT_LOGS_TO_CLIENT = "1";
        DO_NOT_REQUIRE_SSL = "1";
      };
      volumes = [ "${convexDataDir}:/convex/data" ];
    };

    systemd.services.movies = {
      description = "[movies] media service";
      wantedBy = [ "multi-user.target" ];
      requires = [ containerUnit ];
      after = [
        containerUnit
        "network-online.target"
      ];
      wants = [ "network-online.target" ];

      environment = {
        NODE_ENV = "production";
        HOST = cfg.listenAddress;
        PORT = toString cfg.port;
        MEDIA_BASE_URL = cfg.publicUrl;
        CONVEX_URL = convexUrl;
        CONVEX_PUBLIC_URL = cfg.convexPublicUrl;
        CONVEX_BACKEND_DIR = "${cfg.package}/lib/movies/backend";
        DATA_DIR = mediaDataDir;
        BACKUP_DIR = cfg.backupDir;
        BACKUP_RETENTION_DAYS = toString cfg.backupRetentionDays;
        TRANSCODE_DIR = cfg.transcodeDir;
        WEB_DIST_DIR = "/run/movies/web";
        LIBRARY_ROOTS = lib.concatStringsSep "," cfg.libraryDirs;
        HARDWARE_ACCELERATION = cfg.hardwareAcceleration;
        MAX_CONCURRENT_TRANSCODES = toString cfg.maxConcurrentTranscodes;
        FFMPEG_PATH = lib.getExe' cfg.ffmpegPackage "ffmpeg";
        FFPROBE_PATH = lib.getExe' cfg.ffmpegPackage "ffprobe";
      }
      // lib.optionalAttrs (cfg.otlpEndpoint != null) {
        OTEL_EXPORTER_OTLP_ENDPOINT = cfg.otlpEndpoint;
      }
      // lib.optionalAttrs hardware {
        # NixOS keeps VA-API drivers and the oneVPL runtime here (hardware.graphics).
        LIBVA_DRIVERS_PATH = "/run/opengl-driver/lib/dri";
        ONEVPL_SEARCH_PATH = "/run/opengl-driver/lib";
      };

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        # Root and unsandboxed: reaches the container runtime, deploys, writes the environment.
        ExecStartPre = "+${lib.getExe setup}";
        # Written by ExecStartPre; read before ExecStart, so it is optional only for the setup.
        EnvironmentFile = "-/run/movies/media.env";
        ExecStart = lib.getExe' cfg.package "movies-media";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStartSec = "10min";
        RuntimeDirectory = "movies";
        RuntimeDirectoryMode = "0755";

        ReadWritePaths = [
          mediaDataDir
          cfg.backupDir
          cfg.transcodeDir
        ];
        ReadOnlyPaths = cfg.libraryDirs;
        UMask = "0077";
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        PrivateTmp = true;
        PrivateDevices = !hardware;
        DevicePolicy = "closed";
        # The render nodes (/dev/dri/renderD*) are DRM character devices.
        DeviceAllow = lib.optionals hardware [ "char-drm rw" ];
        SupplementaryGroups = lib.optionals hardware [
          "render"
          "video"
        ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        # V8 compiles JavaScript to executable memory.
        MemoryDenyWriteExecute = false;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [
      cfg.port
      cfg.convexPort
    ];
  };
}
