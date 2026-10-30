const {
  controllerRoutes,
  verifyRoutePolicy,
  verifyControllerInventory,
} = require('./controller-route-inventory.cjs');

const routes = controllerRoutes();
test.each(routes)(
  '$verb $route has the reviewed compiled authorization policy',
  (route) => {
    verifyRoutePolicy(route);
  },
);
test('compiled inventory contains 49 routes, 42 protected and seven public including App Links', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 49,
    protected: 42,
    public: 7,
    mismatches: 0,
  });
});
