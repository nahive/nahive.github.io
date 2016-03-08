  /* created by Szymon Maslanka and mighty power of internets */
  var viewportWidth = $(window).width() ;
  var viewportHeight = $(window).height();
  var colours = ['#AE73FF','#EA4C61','#FFCA77','#B0DE2F','#68D5FF'];
  var id = 0;

  function resizetoView(){
    viewportWidth = $(window).width() ;
    viewportHeight = $(window).height();
    $('.screen').height(viewportHeight);
    $('#portfolio_screen').height(viewportHeight*1.25);
    $('.screen #footer').width(viewportWidth);
  }

  function hideHidden(){
    $('#hidden').removeClass('animated fadeIn');
    $('#hidden').addClass('animated fadeOut');
  }

  function showHidden2(){
    $('#hidden2').addClass('animated fadeIn');
    $('#hidden2').show();
    setTimeout(hideHidden2, 3000);
  }

  function hideHidden2(){
    $('#hidden2').removeClass('animated fadeOut');
    $('#hidden2').addClass('animated fadeOut');
  }

  // function changeBackground(){
  //   var scrn = $(".screen");
  //   scrn.animate({backgroundColor: $.Color(scrn.css('backgroundColor')).hue('+=179')}, 3000, animate);
  // }

  $(document).ready( function(){
    //basic resizing so it fits
    resizetoView();
    $(window).bind('resize', resizetoView);
    $("#days").countdown({
      date: "March 11, 2016 17:00:00"
    });
    $('#heart').addClass('animated pulse');
    console.log("fuck");
    $(".screen").animate({backgroundColor: colours[id]},2500);
    id++;
    if (id>colours.length-1) id=0;
    $(".snake-playing-field").animate({backgroundColor: colours[id]},2500);
    id++;
    if (id>colours.length-1) id=0;

    setInterval(function(){
      $(".screen").animate({backgroundColor: colours[id]},2500);
      id++;
      if (id>colours.length-1) id=0;
      $(".snake-playing-field").animate({backgroundColor: colours[id]},2500);
      id++;
      if (id>colours.length-1) id=0;
    },1000);

        //’secret’ specifies the numerical keystrokes that make up the word “mario”
        var secret = "76798669";
        var input = "";
        var timer;
      //The following function sets a timer that checks for user input. You can change the variation in how long the user has to input by changing the number in ‘setTimeout.’ In this case, it’s set for 500 milliseconds or ½ second.
      $(document).keyup(function(e) {
        input += e.which;
        clearTimeout(timer);
        timer = setTimeout(function() { input = ""; }, 500);
        check_input();
      });
      //Once the time is up, this function is run to see if the user’s input is the same as the secret code
      function check_input() {
        if(input == secret) {
          $('#hidden').addClass('animated fadeIn');
          $("#hidden").show();
          setTimeout(showHidden2,2000);
          setTimeout(hideHidden,3000);
        }
      };

      $("#heart").click(function () {
         
      });
    });