#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>

static NSString *profilePathFromArguments(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        NSString *argument = [NSString stringWithUTF8String:argv[i]];
        if ([argument hasPrefix:@"--user-data-dir="]) {
            return [argument substringFromIndex:@"--user-data-dir=".length];
        }
    }
    return nil;
}

// The native E2E fixture models Chromium's per-profile singleton hand-off. A
// second invocation with only a profile and URL records a tab request and
// exits instead of creating another AppKit window. Real Chromium performs the
// same hand-off before the client process becomes a second browser instance.
static BOOL forwardExistingProfileTabIfNeeded(int argc, char **argv) {
    if (![NSProcessInfo.processInfo.environment[@"CLOAK_AUTH_TEST_SINGLETON"] isEqual:@"1"]) return NO;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--new-window") == 0) return NO;
    }
    NSString *profile = profilePathFromArguments(argc, argv);
    if (!profile || argc < 2) return NO;
    NSString *pidPath = [profile stringByAppendingPathComponent:@".native-auth-browser.pid"];
    int pid = [[NSString stringWithContentsOfFile:pidPath encoding:NSUTF8StringEncoding error:nil] intValue];
    if (pid <= 1 || kill(pid, 0) != 0) return NO;
    NSString *requestPath = [profile stringByAppendingPathComponent:@".native-auth-tab-requests"];
    NSString *previous = [NSString stringWithContentsOfFile:requestPath encoding:NSUTF8StringEncoding error:nil] ?: @"";
    NSString *url = [NSString stringWithUTF8String:argv[argc - 1]] ?: @"";
    [[previous stringByAppendingFormat:@"%@\n", url] writeToFile:requestPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    return YES;
}

// Disposable native window fixture with explicit AppKit ownership. It never
// browses the network, reads credentials or uses a real browser profile.
@interface AuthWindowFixture : NSObject
@property(nonatomic, retain) NSWindow *window;
- (void)perform:(NSString *)action;
@end

@implementation AuthWindowFixture
- (void)report:(NSString *)phase {
    puts(phase.UTF8String);
    fflush(stdout);
    if (![NSProcessInfo.processInfo.environment[@"CLOAK_AUTH_TEST_TIMED"] isEqual:@"1"]) return;
    for (NSString *argument in NSProcessInfo.processInfo.arguments) {
        if (![argument hasPrefix:@"--user-data-dir="]) continue;
        NSString *profile = [argument substringFromIndex:@"--user-data-dir=".length];
        [@(getpid()).stringValue writeToFile:[profile stringByAppendingPathComponent:@".native-auth-browser.pid"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        NSString *path = [profile stringByAppendingPathComponent:@".native-auth-window-phases"];
        NSString *previous = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] ?: @"";
        [[previous stringByAppendingFormat:@"%@\n", phase] writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
}
- (void)perform:(NSString *)action {
    @autoreleasepool {
        if ([action isEqual:@"minimize"]) [self.window miniaturize:nil];
        else if ([action isEqual:@"hide"]) [NSApp hide:nil];
        else if ([action isEqual:@"show"]) {
            [NSApp unhideWithoutActivation];
            [self.window deminiaturize:nil];
            [self.window orderFront:nil];
        } else if ([action isEqual:@"close"]) {
            // The retained property releases the final owner below. Asking
            // AppKit to release it too can over-release during pool draining.
            self.window.releasedWhenClosed = NO;
            [self.window close];
            self.window = nil;
        } else if ([action isEqual:@"quit"]) [NSApp terminate:nil];
    }
    [self performSelector:@selector(report:) withObject:action afterDelay:0.2];
    if ([action isEqual:@"close"]) {
        [self performSelector:@selector(perform:) withObject:@"quit" afterDelay:0.45];
    }
}
@end

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0) { puts("Chromium 145.0.7632.109.2"); return 0; }
    }
    if (forwardExistingProfileTabIfNeeded(argc, argv)) return 0;
    @autoreleasepool {
        if ([NSProcessInfo.processInfo.environment[@"CLOAK_AUTH_FIXTURE_PROFILE_GATE"] isEqual:@"1"]) {
            BOOL target = NO;
            for (NSString *argument in NSProcessInfo.processInfo.arguments) {
                if ([argument hasPrefix:@"--user-data-dir="] && ([argument hasSuffix:@"/native-e2e-auth-close-account"] || [argument hasSuffix:@"/native-e2e-auth-success-account"])) target = YES;
            }
            if (!target) return 76;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        AuthWindowFixture *fixture = [[AuthWindowFixture alloc] init];
        @autoreleasepool {
            NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 420, 240) styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
            window.releasedWhenClosed = NO;
            window.title = @"NoTrace 授权生命周期验收（临时窗口）";
            fixture.window = window;
            [window release];
            [fixture.window orderFront:nil];
        }
        if ([NSProcessInfo.processInfo.environment[@"CLOAK_AUTH_TEST_TIMED"] isEqual:@"1"]) {
            for (NSString *argument in NSProcessInfo.processInfo.arguments) {
                if (![argument hasPrefix:@"--user-data-dir="]) continue;
                NSString *profile = [argument substringFromIndex:@"--user-data-dir=".length];
                [@(getpid()).stringValue writeToFile:[profile stringByAppendingPathComponent:@".native-auth-browser.pid"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
                [@"" writeToFile:[profile stringByAppendingPathComponent:@".native-auth-window-phases"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
            }
        }
        [fixture performSelector:@selector(report:) withObject:@"ready" afterDelay:0.3];
        if ([NSProcessInfo.processInfo.environment[@"CLOAK_AUTH_TEST_TIMED"] isEqual:@"1"]) {
            NSArray *actions = @[@"hide", @"show", @"minimize", @"show", @"close"];
            NSArray *delays = @[@6, @8, @9, @11, @13];
            for (NSUInteger i = 0; i < actions.count; i++) [fixture performSelector:@selector(perform:) withObject:actions[i] afterDelay:[delays[i] doubleValue]];
        } else {
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                char input[32];
                while (fgets(input, sizeof(input), stdin)) {
                    NSString *action = [[NSString stringWithUTF8String:input] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                    [fixture performSelectorOnMainThread:@selector(perform:) withObject:action waitUntilDone:NO];
                }
            });
        }
        [fixture performSelector:@selector(perform:) withObject:@"quit" afterDelay:45];
        [NSApp run];
        [fixture release];
    }
    return 0;
}
