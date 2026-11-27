// macOS HiDPI experiments for the reference-screenshot runners.
//   hidpi list                      every display mode, including hidden HiDPI ones
//   hidpi sethidpi <points-width>   switch the main display to a mode with 2x backing pixels
//   hidpi virtual <w> <h> <secs>    create a HiDPI virtual display (private CGVirtualDisplay
//                                   API), make it the main display and keep it alive
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>

static void listModes(CGDirectDisplayID d) {
  NSDictionary *opts = @{ (__bridge id)kCGDisplayShowDuplicateLowResolutionModes: @YES };
  CFArrayRef modes = CGDisplayCopyAllDisplayModes(d, (__bridge CFDictionaryRef)opts);
  printf("display %u:\n", d);
  for (CFIndex i = 0; modes && i < CFArrayGetCount(modes); i++) {
    CGDisplayModeRef m = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, i);
    printf("  %zux%zu points, %zux%zu pixels, %.0f Hz%s\n", CGDisplayModeGetWidth(m), CGDisplayModeGetHeight(m),
      CGDisplayModeGetPixelWidth(m), CGDisplayModeGetPixelHeight(m), CGDisplayModeGetRefreshRate(m),
      CGDisplayModeGetPixelWidth(m) > CGDisplayModeGetWidth(m) ? "  <-- HiDPI" : "");
  }
}

static int setHiDPI(CGDirectDisplayID d, size_t w) {
  NSDictionary *opts = @{ (__bridge id)kCGDisplayShowDuplicateLowResolutionModes: @YES };
  CFArrayRef modes = CGDisplayCopyAllDisplayModes(d, (__bridge CFDictionaryRef)opts);
  for (CFIndex i = 0; modes && i < CFArrayGetCount(modes); i++) {
    CGDisplayModeRef m = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, i);
    if (CGDisplayModeGetWidth(m) == w && CGDisplayModeGetPixelWidth(m) == 2 * w) {
      CGDisplayConfigRef cfg; CGBeginDisplayConfiguration(&cfg);
      CGConfigureDisplayWithDisplayMode(cfg, d, m, NULL);
      CGError e = CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession);
      printf("switched to %zu points HiDPI: error %d\n", w, e);
      return e;
    }
  }
  printf("no HiDPI mode with width %zu\n", w);
  return 1;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    CGDirectDisplayID ids[16]; uint32_t n = 0;
    CGGetOnlineDisplayList(16, ids, &n);
    NSString *cmd = argc > 1 ? @(argv[1]) : @"list";
    if ([cmd isEqualToString:@"list"]) {
      for (uint32_t i = 0; i < n; i++) listModes(ids[i]);
    } else if ([cmd isEqualToString:@"sethidpi"]) {
      return setHiDPI(CGMainDisplayID(), (size_t)atoi(argv[2]));
    } else if ([cmd isEqualToString:@"virtual"]) {
      NSUInteger w = atoi(argv[2]), h = atoi(argv[3]); double secs = atof(argv[4]);
      Class D = NSClassFromString(@"CGVirtualDisplayDescriptor"), M = NSClassFromString(@"CGVirtualDisplayMode"),
            S = NSClassFromString(@"CGVirtualDisplaySettings"), V = NSClassFromString(@"CGVirtualDisplay");
      printf("classes: %d %d %d %d\n", D != nil, M != nil, S != nil, V != nil);
      if (!D || !M || !S || !V) return 2;
      id d = [[D alloc] init];
      [d setValue:@"Pane" forKey:@"name"];
      [d setValue:dispatch_get_main_queue() forKey:@"queue"];
      [d setValue:@(w * 2) forKey:@"maxPixelsWide"]; [d setValue:@(h * 2) forKey:@"maxPixelsHigh"];
      [d setValue:[NSValue valueWithSize:NSMakeSize(w * 0.2, h * 0.2)] forKey:@"sizeInMillimeters"];
      [d setValue:@(0x1234) forKey:@"productID"]; [d setValue:@(0x5678) forKey:@"vendorID"]; [d setValue:@(1) forKey:@"serialNum"];
      id mode = ((id (*)(id, SEL, NSUInteger, NSUInteger, double))objc_msgSend)([M alloc], sel_getUid("initWithWidth:height:refreshRate:"), w, h, 60.0);
      id settings = [[S alloc] init];
      [settings setValue:@(1) forKey:@"hiDPI"]; [settings setValue:@[mode] forKey:@"modes"];
      id vd = ((id (*)(id, SEL, id))objc_msgSend)([V alloc], sel_getUid("initWithDescriptor:"), d);
      BOOL ok = ((BOOL (*)(id, SEL, id))objc_msgSend)(vd, sel_getUid("applySettings:"), settings);
      CGDirectDisplayID vid = [[vd valueForKey:@"displayID"] unsignedIntValue];
      printf("virtual display %u created, settings applied: %d\n", vid, ok);
      fflush(stdout);
      // make the virtual display the main one (origin 0,0) and park the others to its right
      CGDisplayConfigRef cfg; CGBeginDisplayConfiguration(&cfg);
      CGConfigureDisplayOrigin(cfg, vid, 0, 0);
      int x = (int)w + 100;
      CGGetOnlineDisplayList(16, ids, &n);
      for (uint32_t i = 0; i < n; i++) if (ids[i] != vid) { CGConfigureDisplayOrigin(cfg, ids[i], x, 0); x += 2000; }
      printf("arrange: %d\n", CGCompleteDisplayConfiguration(cfg, kCGConfigureForSession));
      fflush(stdout);
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:secs]];
    }
  }
  return 0;
}
