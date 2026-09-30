use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use cloak_core::{
    auth_status, build_launch_plan, create_account, delete_account, launch_account, list_accounts,
    list_trashed_accounts, login_account_auth, permanently_delete_account, push_local_grant,
    read_account, refresh_account_auth, refresh_all_account_auth, rename_account,
    self_check_report, set_account_trashed, set_auth_authority, set_group, set_mark, set_proxy,
    set_region, toggle_locale, AuthAuthority, CloakConfig, LaunchOptions,
};

#[derive(Debug, Parser)]
#[command(name = "cloak", version, about = "Cloak account launcher")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Account {
        #[command(subcommand)]
        command: AccountCommand,
    },
    Launch(LaunchArgs),
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    SelfCheck {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    Status {
        name: String,
    },
    Login {
        name: String,
    },
    Refresh {
        name: String,
    },
    Authority {
        name: String,
        #[arg(value_enum)]
        authority: AuthorityArg,
    },
    BrokerPush {
        name: String,
        #[arg(long, env = "NOTRACE_BROKER_ENDPOINT")]
        endpoint: String,
    },
    RefreshAll,
}

#[derive(Debug, Clone, clap::ValueEnum)]
enum AuthorityArg {
    NoTrace,
    Codex,
    Cpa,
    Cockpit,
    Broker,
}

#[derive(Debug, Subcommand)]
enum AccountCommand {
    List {
        #[arg(long)]
        json: bool,
    },
    ListTrashed {
        #[arg(long)]
        json: bool,
    },
    Create {
        name: String,
        #[arg(long)]
        json: bool,
    },
    Rename {
        old: String,
        new: String,
        #[arg(long)]
        json: bool,
    },
    Delete {
        name: String,
    },
    Purge {
        name: String,
    },
    Restore {
        name: String,
        #[arg(long)]
        json: bool,
    },
    SetProxy {
        name: String,
        value: Option<String>,
        #[arg(long)]
        clear: bool,
        #[arg(long)]
        json: bool,
    },
    SetRegion {
        name: String,
        value: Option<String>,
        #[arg(long)]
        clear: bool,
        #[arg(long)]
        json: bool,
    },
    SetGroup {
        name: String,
        value: Option<String>,
        #[arg(long)]
        clear: bool,
        #[arg(long)]
        json: bool,
    },
    SetMark {
        name: String,
        value: Option<String>,
        #[arg(long, value_name = "COLOR")]
        color: Option<String>,
        #[arg(long)]
        clear: bool,
        #[arg(long)]
        json: bool,
    },
    ToggleLocale {
        name: String,
        #[arg(long)]
        json: bool,
    },
    Show {
        name: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Args)]
struct LaunchArgs {
    name: String,
    #[arg(long)]
    dry_run: bool,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    skip_geo: bool,
}

fn main() -> Result<()> {
    if cloak_core::maybe_run_relay_supervisor()? {
        return Ok(());
    }

    let cli = Cli::parse();
    let config = CloakConfig::from_env().context("load Cloak config")?;

    match cli.command {
        Command::Account { command } => handle_account(command, &config),
        Command::Launch(args) => handle_launch(args, &config),
        Command::Auth { command } => handle_auth(command, &config),
        Command::SelfCheck { json } => {
            let report = self_check_report(&config)?;
            if json {
                print_json(&report)?;
            } else {
                println!("{}", report.message);
            }
            if !report.ok {
                anyhow::bail!(report.runtime.message);
            }
            Ok(())
        }
    }
}

fn handle_auth(command: AuthCommand, config: &CloakConfig) -> Result<()> {
    match command {
        AuthCommand::Status { name } => print_json(&auth_status(config, &name)?)?,
        AuthCommand::Login { name } => print_json(&login_account_auth(config, &name)?)?,
        AuthCommand::Refresh { name } => print_json(&refresh_account_auth(config, &name)?)?,
        AuthCommand::Authority { name, authority } => {
            let authority = match authority {
                AuthorityArg::NoTrace => AuthAuthority::NoTrace,
                AuthorityArg::Codex => AuthAuthority::Codex,
                AuthorityArg::Cpa => AuthAuthority::Cpa,
                AuthorityArg::Cockpit => AuthAuthority::Cockpit,
                AuthorityArg::Broker => AuthAuthority::Broker,
            };
            print_json(&set_auth_authority(config, &name, authority)?)?;
        }
        AuthCommand::BrokerPush { name, endpoint } => {
            let key = std::env::var("NOTRACE_BROKER_ADMIN_KEY")
                .context("missing NOTRACE_BROKER_ADMIN_KEY")?;
            print_json(&push_local_grant(config, &name, &endpoint, &key)?)?;
        }
        AuthCommand::RefreshAll => {
            let mut accounts = list_accounts(config)?;
            accounts.extend(list_trashed_accounts(config)?);
            let names = accounts
                .into_iter()
                .map(|account| account.name)
                .collect::<Vec<_>>();
            print_json(&refresh_all_account_auth(config, &names))?;
        }
    }
    Ok(())
}

fn handle_account(command: AccountCommand, config: &CloakConfig) -> Result<()> {
    match command {
        AccountCommand::List { json } => {
            let accounts = list_accounts(config)?;
            print_account_list(accounts, json)?;
        }
        AccountCommand::ListTrashed { json } => {
            let accounts = list_trashed_accounts(config)?;
            print_account_list(accounts, json)?;
        }
        AccountCommand::Create { name, json } => {
            let account = create_account(config, &name)?;
            print_account(account, json)?;
        }
        AccountCommand::Rename { old, new, json } => {
            let account = rename_account(config, &old, &new)?;
            print_account(account, json)?;
        }
        AccountCommand::Delete { name } => {
            delete_account(config, &name)?;
            println!("moved to trash: {name}");
        }
        AccountCommand::Purge { name } => {
            permanently_delete_account(config, &name)?;
            println!("permanently deleted: {name}");
        }
        AccountCommand::Restore { name, json } => {
            let account = set_account_trashed(config, &name, false)?;
            print_account(account, json)?;
        }
        AccountCommand::SetProxy {
            name,
            value,
            clear,
            json,
        } => {
            let account = set_proxy(config, &name, if clear { None } else { value.as_deref() })?;
            print_account(account, json)?;
        }
        AccountCommand::SetRegion {
            name,
            value,
            clear,
            json,
        } => {
            let account = set_region(config, &name, if clear { None } else { value.as_deref() })?;
            print_account(account, json)?;
        }
        AccountCommand::SetGroup {
            name,
            value,
            clear,
            json,
        } => {
            let account = set_group(config, &name, if clear { None } else { value.as_deref() })?;
            print_account(account, json)?;
        }
        AccountCommand::SetMark {
            name,
            value,
            color,
            clear,
            json,
        } => {
            let account = set_mark(
                config,
                &name,
                !clear,
                if clear { None } else { value.as_deref() },
                if clear { None } else { color.as_deref() },
            )?;
            print_account(account, json)?;
        }
        AccountCommand::ToggleLocale { name, json } => {
            let account = toggle_locale(config, &name)?;
            print_account(account, json)?;
        }
        AccountCommand::Show { name, json } => {
            let account = read_account(config, &name)?;
            print_account(account, json)?;
        }
    }
    Ok(())
}

fn handle_launch(args: LaunchArgs, config: &CloakConfig) -> Result<()> {
    let mut options = LaunchOptions::from_env(args.dry_run);
    if args.skip_geo {
        options.skip_geo = true;
    }

    if args.dry_run {
        let plan = build_launch_plan(config, &args.name, &options)?;
        if args.json {
            print_json(&plan)?;
        } else {
            println!("account : {}", plan.account);
            println!("seed    : {}", plan.seed);
            println!(
                "exit ip : {}",
                plan.geo.exit_ip.as_deref().unwrap_or("unknown")
            );
            println!(
                "timezone: {}",
                plan.geo.timezone.as_deref().unwrap_or("unknown")
            );
            println!(
                "locale  : {}",
                plan.locale
                    .as_deref()
                    .unwrap_or("off (navigator.languages = browser default)")
            );
            println!("proxy   : {}", plan.proxy.display);
            if plan.extra_extension_paths.is_empty() {
                println!("plugins : none");
            } else {
                println!(
                    "plugins : {}",
                    plan.extra_extension_paths
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                );
                println!(
                    "selftest plugins: {}",
                    if plan.selftest_extension_paths.is_empty() {
                        "none".to_string()
                    } else {
                        plan.selftest_extension_paths
                            .iter()
                            .map(|path| path.display().to_string())
                            .collect::<Vec<_>>()
                            .join(" ")
                    }
                );
            }
            println!("profile : {}", plan.profile_path.display());
            println!("binary  : {}", plan.browser_binary.display());
            print!("argv    : {}", plan.browser_binary.display());
            for arg in &plan.argv {
                print!(" {}", shell_escape(arg));
            }
            println!();
            if !plan.privacy_failures.is_empty() {
                eprintln!("privacy failures:");
                for failure in &plan.privacy_failures {
                    eprintln!("- {failure}");
                }
            }
        }
        return Ok(());
    }

    let result = launch_account(config, &args.name, &options)?;
    if args.json {
        print_json(&result)?;
    } else {
        println!("launched: {} (pid {})", result.account, result.pid);
        println!("engine  : Chromium {}", result.diagnostics.engine_version);
        println!(
            "timing  : preflight {} ms + launch {} ms",
            result.diagnostics.preflight_ms, result.diagnostics.launch_ms
        );
        println!("proxy   : {}", result.diagnostics.proxy_display);
        println!(
            "exit ip : {}",
            result.diagnostics.exit_ip.as_deref().unwrap_or("unknown")
        );
    }
    Ok(())
}

fn print_account(account: cloak_core::Account, json: bool) -> Result<()> {
    if json {
        print_json(&account)?;
    } else {
        let mark = account_mark(&account).to_string();
        println!("account : {}", account.name);
        println!("seed    : {}", account.seed);
        println!("status  : {}", account_status(&account));
        println!(
            "group   : {}",
            account.group.unwrap_or_else(|| "-".to_string())
        );
        println!("mark    : {mark}");
        println!("profile : {}", account.profile_path.display());
        println!(
            "region  : {}",
            account.region.unwrap_or_else(|| "-".to_string())
        );
        println!(
            "locale  : {}",
            if account.locale_enabled { "on" } else { "off" }
        );
        println!("proxy   : {}", account.proxy_display);
    }
    Ok(())
}

fn print_account_list(accounts: Vec<cloak_core::Account>, json: bool) -> Result<()> {
    if json {
        print_json(&accounts)?;
    } else {
        for account in accounts {
            let mark = account_mark(&account).to_string();
            println!(
                "{}\tseed {}\tstatus {}\tgroup {}\tmark {}\tregion {}\tlocale {}\tproxy {}",
                account.name,
                account.seed,
                account_status(&account),
                account.group.unwrap_or_else(|| "-".to_string()),
                mark,
                account.region.unwrap_or_else(|| "-".to_string()),
                if account.locale_enabled { "on" } else { "off" },
                account.proxy_display
            );
        }
    }
    Ok(())
}

fn account_mark(account: &cloak_core::Account) -> &str {
    if account.marked {
        account.mark_note.as_deref().unwrap_or("yes")
    } else {
        "-"
    }
}

fn account_status(account: &cloak_core::Account) -> &'static str {
    if account.trashed {
        "trashed"
    } else if account.archived {
        "archived"
    } else {
        "active"
    }
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn shell_escape(value: &str) -> String {
    if value.bytes().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_' | b':' | b'=' | b'@')
    }) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
