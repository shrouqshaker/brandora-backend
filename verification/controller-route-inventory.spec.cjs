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
test('compiled inventory contains 55 routes, 48 protected and seven public', () => {
  expect(verifyControllerInventory(routes)).toEqual({
    routes: 55,
    protected: 48,
    public: 7,
    mismatches: 0,
  });
});
